require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeUsersTable, hashPassword, comparePassword, generateToken, authMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  // Initialize users table for authentication
  initializeUsersTable(db);

  // 1. Profile Table
  db.run(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY,
      name TEXT DEFAULT 'Nikhil',
      streak INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      xp_max INTEGER DEFAULT 100,
      level TEXT DEFAULT 'Level 1 - 🌱 Eco Rookie',
      co2_kg INTEGER DEFAULT 0,
      water_l TEXT DEFAULT '0',
      waste_kg INTEGER DEFAULT 0,
      last_active_date TEXT DEFAULT ''
    )
  `);

  // Safe initial seed for user
  db.run(`
    INSERT OR IGNORE INTO profile (id, name, streak, xp, xp_max, level, co2_kg, water_l, waste_kg, last_active_date) 
    VALUES (1, 'Nikhil', 0, 0, 100, 'Level 1 - 🌱 Eco Rookie', 0, '0', 0, '')
  `);

 // 2. Quests Table
  db.run(`
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      xp_reward INTEGER,
      completed INTEGER DEFAULT 0,
      last_completed_date TEXT DEFAULT ''
    )
  `);

  // Ensure column exists for existing DBs
  db.run(`ALTER TABLE quests ADD COLUMN last_completed_date TEXT DEFAULT ''`, () => {});

  // Safe seed for initial quests
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (1, 'Brought a Reusable Bag', 15, 0, '')`);
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (2, 'Zero Leftover Meal', 20, 0, '')`);
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (3, 'Walk / Cycle Short Trips', 25, 0, '')`);
  // 3. Reports Table
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL,
      lng REAL,
      location TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ==================== AUTHENTICATION ENDPOINTS ====================

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, city, email, password } = req.body;

    // Validation
    if (!name || !city || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if email already exists
    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      
      if (row) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      try {
        const hashedPassword = await hashPassword(password);

        db.run(
          'INSERT INTO users (name, email, city, password) VALUES (?, ?, ?, ?)',
          [name.trim(), email.trim(), city.trim(), hashedPassword],
          function (insertErr) {
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            
            const token = generateToken(this.lastID, email, name);
            res.status(201).json({
              success: true,
              message: 'Account created successfully',
              token,
              user: {
                id: this.lastID,
                name: name.trim(),
                email: email.trim(),
                city: city.trim()
              }
            });
          }
        );
      } catch (hashErr) {
        return res.status(500).json({ error: 'Failed to create account' });
      }
    });
  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ error: error.message || 'Signup failed' });
  }
});

// Sign In
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email.trim()], async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      try {
        const isPasswordValid = await comparePassword(password, user.password);

        if (!isPasswordValid) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = generateToken(user.id, user.email, user.name);
        res.json({
          success: true,
          token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            city: user.city,
            created_at: user.created_at
          }
        });
      } catch (compareErr) {
        return res.status(500).json({ error: 'Authentication failed' });
      }
    });
  } catch (error) {
    console.error('Signin Error:', error);
    res.status(500).json({ error: error.message || 'Signin failed' });
  }
});

// Get User Profile (Protected)
app.get('/api/auth/profile', authMiddleware, (req, res) => {
  db.get('SELECT id, name, email, city, created_at, updated_at FROM users WHERE id = ?', 
    [req.user.userId], 
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    }
  );
});

// Update Profile (Protected)
app.put('/api/auth/update-profile', authMiddleware, (req, res) => {
  try {
    const { name, city, email } = req.body;
    const userId = req.user.userId;

    if (!name || !city || !email) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if new email is already taken by another user
    db.get('SELECT id FROM users WHERE email = ? AND id != ?', 
      [email.trim(), userId], 
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row) {
          return res.status(400).json({ error: 'Email already in use' });
        }

        db.run(
          'UPDATE users SET name = ?, city = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [name.trim(), city.trim(), email.trim(), userId],
          function (updateErr) {
            if (updateErr) return res.status(500).json({ error: updateErr.message });
            res.json({
              success: true,
              message: 'Profile updated successfully',
              user: {
                id: userId,
                name: name.trim(),
                email: email.trim(),
                city: city.trim()
              }
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

// Change Password (Protected)
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    db.get('SELECT password FROM users WHERE id = ?', [userId], async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });

      try {
        const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);

        if (!isCurrentPasswordValid) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedNewPassword = await hashPassword(newPassword);

        db.run(
          'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [hashedNewPassword, userId],
          function (updateErr) {
            if (updateErr) return res.status(500).json({ error: updateErr.message });
            res.json({
              success: true,
              message: 'Password changed successfully'
            });
          }
        );
      } catch (compareErr) {
        return res.status(500).json({ error: 'Failed to change password' });
      }
    });
  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ error: error.message || 'Failed to change password' });
  }
});

// ==================== EXISTING ENDPOINTS ====================

// Evaluate Streak Status, Expiration, and Multipliers
function evaluateStreak(profile) {
  if (!profile || !profile.last_active_date) {
    return { streak: 0, multiplier: 1.0, diffDays: 999 };
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const lastDate = new Date(profile.last_active_date);
  const today = new Date(todayStr);
  const diffDays = Math.round((today - lastDate) / (1000 * 60 * 60 * 24));

  let currentStreak = profile.streak || 0;

  // Streak resets to 0 if more than 1 day missed
  if (diffDays > 1) {
    currentStreak = 0;
  }

  // Calculate XP Multiplier
  let multiplier = 1.0;
  if (currentStreak >= 14) multiplier = 2.0;
  else if (currentStreak >= 7) multiplier = 1.5;
  else if (currentStreak >= 3) multiplier = 1.2;

  return { streak: currentStreak, multiplier, diffDays };
}

app.get('/api/dashboard', (req, res) => {
  const todayStr = new Date().toISOString().split('T')[0];

  // Auto-refresh quests if last completed date is not today
  db.run(`UPDATE quests SET completed = 0 WHERE last_completed_date != ?`, [todayStr], () => {
    db.get('SELECT * FROM profile WHERE id = 1', (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      const streakData = evaluateStreak(user);

      // If streak expired while user was away, sync DB automatically
      const updateStreak = (streakData.streak !== user?.streak)
        ? new Promise((resolve) => db.run('UPDATE profile SET streak = ? WHERE id = 1', [streakData.streak], resolve))
        : Promise.resolve();

      updateStreak.then(() => {
        db.all('SELECT * FROM quests', (err, quests) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            user: { ...user, streak: streakData.streak, multiplier: streakData.multiplier },
            quests
          });
        });
      });
    });
  });
});

// Claim Quest, Increase XP & Manage Daily Streak
app.post('/api/quests/toggle', (req, res) => {
  const { questId, completed } = req.body;
  const isDone = completed ? 1 : 0;
  const todayStr = new Date().toISOString().split('T')[0];

  db.get('SELECT xp_reward, completed FROM quests WHERE id = ?', [questId], (err, quest) => {
    if (err) return res.status(500).json({ error: err.message });
    if (isDone && quest && quest.completed === 1) {
      return res.status(400).json({ error: 'Quest already claimed for today!' });
    }

    const rawXp = quest ? quest.xp_reward : (parseInt(req.body.xp, 10) || 15);

    db.get('SELECT xp, streak, last_active_date FROM profile WHERE id = 1', (err, profile) => {
      if (err) return res.status(500).json({ error: err.message });

      const streakData = evaluateStreak(profile);
      let newStreak = streakData.streak;

      if (isDone) {
        if (!profile?.last_active_date) {
          newStreak = 1;
        } else if (streakData.diffDays === 1) {
          newStreak += 1;
        } else if (streakData.diffDays > 1) {
          newStreak = 1;
        }
      }

      // Apply streak multiplier boost
      const earnedXp = Math.round(rawXp * streakData.multiplier);
      const xpChange = isDone ? earnedXp : -earnedXp;

      // 1. Update Profile (XP, Streak, Active Date)
      db.run(
        'UPDATE profile SET xp = MAX(0, xp + ?), streak = ?, last_active_date = ? WHERE id = 1',
        [xpChange, newStreak, todayStr],
        function (updateErr) {
          if (updateErr) return res.status(500).json({ error: updateErr.message });

          // 2. Mark Quest as Completed & Record Today's Date
          db.run(
            'UPDATE quests SET completed = ?, last_completed_date = ? WHERE id = ?',
            [isDone, isDone ? todayStr : '', questId],
            function (questErr) {
              if (questErr) return res.status(500).json({ error: questErr.message });

              db.get('SELECT * FROM profile WHERE id = 1', (fetchErr, updatedUser) => {
                if (fetchErr) return res.status(500).json({ error: fetchErr.message });
                res.json({ success: true, user: updatedUser, earnedXp, multiplier: streakData.multiplier });
              });
            }
          );
        }
      );
    });
  });
});

app.get('/api/reports', (req, res) => {
  db.all('SELECT * FROM reports ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// AI Community Waste Report (Auto-Drafting & Severity Analysis)
app.post('/api/reports', async (req, res) => {
  try {
    const { lat, lng, location, description, imageBase64 } = req.body;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location coordinates.' });
    }

    let severity = "Moderate Waste";
    let complaintDraft = `Official Waste Clearance Request:\nLocation: ${location || 'Coordinates ' + lat + ', ' + lng}\nDetails: ${description || 'Illegal garbage accumulation reported.'}\nPlease act immediately.`;

    // If an image or description is provided, use Gemini to classify and draft an official complaint
    if (imageBase64 || description) {
      const prompt = `You are a municipal civic assistant. Analyze this reported garbage hotspot (Description: "${description || 'None'}") and generate a JSON response matching:
{
  "severity": "High Biohazard" | "Plastic Accumulation" | "Drainage Blockage" | "General Litter",
  "complaint_draft": "A professional, polite 2-sentence complaint addressed to municipal sanitation authorities requesting quick clearance with the coordinates (${lat}, ${lng})."
}
Return ONLY valid JSON.`;

      let parts = [prompt];
      if (imageBase64) {
        parts.push({
          inlineData: {
            data: imageBase64,
            mimeType: "image/jpeg"
          }
        });
      }

      const result = await model.generateContent(parts);
      const response = await result.response;
      
      let rawText = response.text().trim();
      if (rawText.startsWith('```json')) {
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      } else if (rawText.startsWith('```')) {
        rawText = rawText.replace(/```/g, '').trim();
      }

      const parsed = JSON.parse(rawText);
      severity = parsed.severity || severity;
      complaintDraft = parsed.complaint_draft || complaintDraft;
    }

    db.run(
      'INSERT INTO reports (lat, lng, location, description) VALUES (?, ?, ?, ?)',
      [lat, lng, location || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`, `${severity} - ${description || 'Hotspot reported'}`],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Award +30 XP, 3kg waste diverted, 8kg CO2 saved, and 300L water saved
        db.run(
          'UPDATE profile SET xp = xp + 30, waste_kg = waste_kg + 3, co2_kg = co2_kg + 8, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 300 WHERE id = 1',
          function (updateErr) {
            if (updateErr) console.error('Profile update error:', updateErr);
            res.json({
              id: this.lastID,
              success: true,
              severity,
              complaintDraft,
              lat,
              lng
            });
          }
        );
      }
    );
  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
});

// AI Waste Scanner (Structured 3-Second Bin Output)
app.post('/api/ai/scan-waste', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = `Analyze this waste/item image. Return ONLY a valid JSON object matching this exact schema:
{
  "item_name": "Short name of item",
  "bin_type": "Blue (Dry/Recycle)" | "Green (Organic/Wet)" | "Red (Hazardous/E-Waste)" | "Black (Landfill)",
  "bin_color": "blue" | "green" | "red" | "black",
  "prep_tip": "One short sentence on what to do before throwing (e.g., Rinse residue, crush flat, remove cap)",
  "recyclable": true
}
Do not include markdown fences or any other text outside the JSON.`;

    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg"
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    
    // Clean up markdown formatting in response text
    let rawText = response.text().trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/```/g, '').trim();
    }

    const parsedData = JSON.parse(rawText);

    // Ensure database write completes before returning response to client
    db.run(
      'UPDATE profile SET xp = xp + 25, waste_kg = waste_kg + 1, co2_kg = co2_kg + 3, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 120 WHERE id = 1',
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json(parsedData);
      }
    );
  } catch (error) {
    console.error("Waste Scan Error:", error);
    res.status(500).json({ error: error.message || 'Failed to analyze item' });
  }
});

// AI Food Rescue (Structured Zero-Waste Recipe Output)
app.post('/api/ai/food-rescue', async (req, res) => {
  try {
    const { ingredients, imageBase64 } = req.body;
    let parts = [];

    const prompt = `You are a zero-waste chef. Analyze the provided ingredients or image. Return ONLY a valid JSON object matching this exact schema:
{
  "recipe_name": "Appealing, simple recipe name",
  "cook_time": "e.g., 15 mins",
  "difficulty": "Easy" | "Medium",
  "eat_first_warning": "Name 1 ingredient that spoils fastest and needs to be used immediately",
  "ingredients_used": ["List of main ingredients"],
  "substitutions": "1 quick pantry swap tip if they are missing common seasoning/oil",
  "instructions": [
    "Step 1: Prep and chop...",
    "Step 2: Cook...",
    "Step 3: Garnish and serve..."
  ]
}
Keep steps ultra-simple and focused on saving food from going to waste. Do not include markdown fences or any text outside JSON.`;

    if (imageBase64) {
      parts.push(prompt);
      parts.push({
        inlineData: {
          data: imageBase64,
          mimeType: "image/jpeg"
        }
      });
    } else if (ingredients) {
      parts.push(`${prompt}\n\nAvailable Ingredients: ${ingredients}`);
    } else {
      return res.status(400).json({ error: 'Please enter ingredients or scan food items.' });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;

    let rawText = response.text().trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/```/g, '').trim();
    }

    const parsedRecipe = JSON.parse(rawText);

    db.run(
      'UPDATE profile SET xp = xp + 20, waste_kg = waste_kg + 1, co2_kg = co2_kg + 2, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 250 WHERE id = 1',
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json(parsedRecipe);
      }
    );
  } catch (error) {
    console.error("Food Rescue Error:", error);
    res.status(500).json({ error: error.message || 'Failed to generate recipe' });
  }
});

// Update / Create Profile
app.post('/api/profile/update', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  db.run(
    'UPDATE profile SET name = ? WHERE id = 1',
    [name.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, name: name.trim() });
    }
  );
});

// Database seed for community leaderboard if table doesn't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    xp INTEGER,
    streak INTEGER,
    avatar TEXT
  )`);

  // Insert mock competitors if empty
  db.get("SELECT COUNT(*) as count FROM leaderboard", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Aarav Sharma', 620, 12, 'A')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Priya Patel', 410, 8, 'P')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Rohan Verma', 280, 4, 'R')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Ananya Iyer', 190, 3, 'A')");
    }
  });
});

// Dynamic Leaderboard with WasteHunter Level Tiers
app.get('/api/leaderboard', (req, res) => {
  db.get('SELECT name, xp, streak FROM users WHERE id = 1', [], (err, currentUser) => {
    if (err) return res.status(500).json({ error: err.message });

    const calculateLevelNum = (xp) => {
      if (xp >= 3000) return 100;
      if (xp >= 1500) return 50;
      if (xp >= 700) return 20;
      if (xp >= 300) return 10;
      if (xp >= 100) return 5;
      return 1;
    };

    const userXP = currentUser ? currentUser.xp : 0;
    const userStreak = currentUser ? currentUser.streak : 0;
    const userName = currentUser ? currentUser.name : 'Hunter';

    // Mock community hunters matching the concept UI
    const mockHunters = [
      { name: 'Rahul', xp: 12450, streak: 18, avatar: 'R', level: 24, isCurrent: false },
      { name: 'Priya', xp: 11800, streak: 15, avatar: 'P', level: 22, isCurrent: false },
      { name: 'Sameer', xp: 10950, streak: 12, avatar: 'S', level: 20, isCurrent: false },
      { name: 'Ananya', xp: 9750, streak: 9, avatar: 'A', level: 18, isCurrent: false },
      { name: 'Arjun', xp: 8600, streak: 7, avatar: 'A', level: 17, isCurrent: false },
    ];

    const currentHunter = {
      name: userName,
      xp: userXP,
      streak: userStreak,
      avatar: userName.charAt(0).toUpperCase(),
      level: calculateLevelNum(userXP),
      isCurrent: true
    };

    // Combine and sort by XP descending
    const allHunters = [...mockHunters, currentHunter].sort((a, b) => b.xp - a.xp);

    res.json(allHunters);
  });
});

// Complete any Quest with Custom XP & Streak addition
app.post('/api/profile/quest', (req, res) => {
  const xpReward = parseInt(req.body.xp) || 15;
  db.run(
    'UPDATE profile SET xp = xp + ?, streak = streak + 1 WHERE id = 1',
    [xpReward],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM profile WHERE id = 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, user: row, addedXp: xpReward });
      });
    }
  );
});

// Alias /dashboard.html to /index.html
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
