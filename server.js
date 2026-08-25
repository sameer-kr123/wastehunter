require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeUsersTable, hashPassword, comparePassword, generateToken, authMiddleware } = require('./auth');

// 1. Initialize Postgres Pool
// 1. Initialize Postgres Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

// Database Initialization Function for Postgres (Neon)
async function initDB() {
  try {
    // Initialize users table
    await initializeUsersTable(pool);

    // 1. Profile Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'Nikhil',
        streak INTEGER DEFAULT 0,
        xp INTEGER DEFAULT 0,
        xp_max INTEGER DEFAULT 100,
        level TEXT DEFAULT 'Level 1 - 🌱 Eco Rookie',
        co2_kg INTEGER DEFAULT 0,
        water_l TEXT DEFAULT '0',
        waste_kg INTEGER DEFAULT 0,
        last_active_date TEXT DEFAULT ''
      );
    `);

    // Safe initial seed for user
    await pool.query(`
      INSERT INTO profile (id, name, streak, xp, xp_max, level, co2_kg, water_l, waste_kg, last_active_date)
      VALUES (1, 'Nikhil', 0, 0, 100, 'Level 1 - 🌱 Eco Rookie', 0, '0', 0, '')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Quests Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id SERIAL PRIMARY KEY,
        title TEXT,
        xp_reward INTEGER,
        completed INTEGER DEFAULT 0,
        last_completed_date TEXT DEFAULT ''
      );
    `);

    // Safe seed for initial quests
    await pool.query(`
      INSERT INTO quests (id, title, xp_reward, completed, last_completed_date)
      VALUES 
        (1, 'Brought a Reusable Bag', 15, 0, ''),
        (2, 'Zero Leftover Meal', 20, 0, ''),
        (3, 'Walk / Cycle Short Trips', 25, 0, '')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 3. Reports Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        lat REAL,
        lng REAL,
        location TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Leaderboard Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        id SERIAL PRIMARY KEY,
        name TEXT,
        xp INTEGER,
        streak INTEGER,
        avatar TEXT
      );
    `);

    const countRes = await pool.query('SELECT COUNT(*) as count FROM leaderboard');
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      await pool.query(`
        INSERT INTO leaderboard (name, xp, streak, avatar) VALUES 
          ('Aarav Sharma', 620, 12, 'A'),
          ('Priya Patel', 410, 8, 'P'),
          ('Rohan Verma', 280, 4, 'R'),
          ('Ananya Iyer', 190, 3, 'A');
      `);
    }

    console.log('Connected to Neon PostgreSQL & All Tables Initialized Successfully!');
  } catch (err) {
    console.error('Database setup failed:', err);
  }
}

initDB();

// ==================== AUTHENTICATION ENDPOINTS ====================

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, city, email, password } = req.body;

    if (!name || !city || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if email already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await hashPassword(password);

    const result = await pool.query(
      'INSERT INTO users (name, email, city, password) VALUES ($1, $2, $3, $4) RETURNING id',
      [name.trim(), email.trim(), city.trim(), hashedPassword]
    );

    const userId = result.rows[0].id;

    // Initialize blank profile for the new user
    await pool.query(`
      INSERT INTO profile (id, name, streak, xp, xp_max, level, co2_kg, water_l, waste_kg, last_active_date)
      VALUES ($1, $2, 0, 0, 100, 'Level 1 - 🌱 Eco Rookie', 0, '0', 0, '')
    `, [userId, name.trim()]);
    const token = generateToken({ id: userId, email: email.trim(), name: name.trim() });

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        id: userId,
        name: name.trim(),
        email: email.trim(),
        city: city.trim()
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

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken({ id: user.id, email: user.email, name: user.name });

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
  } catch (error) {
    console.error('Signin Error:', error);
    res.status(500).json({ error: error.message || 'Signin failed' });
  }
});

// Get User Profile (Protected)
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, city, created_at, updated_at FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Profile (Protected)
app.put('/api/auth/update-profile', authMiddleware, async (req, res) => {
  try {
    const { name, city, email } = req.body;
    const userId = req.user.id;

    if (!name || !city || !email) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.trim(), userId]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    await pool.query(
      'UPDATE users SET name = $1, city = $2, email = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      [name.trim(), city.trim(), email.trim(), userId]
    );

    // ADD THIS: Keep the gamification profile in sync!
    await pool.query('UPDATE profile SET name = $1 WHERE id = $2', [name.trim(), userId]);

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
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

// Change Password (Protected)
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const result = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    if (!user) return res.status(404).json({ error: 'User not found' });

    const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedNewPassword = await hashPassword(newPassword);

    await pool.query(
      'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedNewPassword, userId]
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ error: error.message || 'Failed to change password' });
  }
});

// ==================== DASHBOARD & QUEST ENDPOINTS ====================

// Helper to safely add XP and calculate new streaks
async function addXpAndUpdateStreak(userId, xpToAdd, wasteKg = 0, co2Kg = 0, waterL = 0) {
  const profileRes = await pool.query('SELECT streak, last_active_date FROM profile WHERE id = $1', [userId]);
  const profile = profileRes.rows[0];
  
  const streakData = evaluateStreak(profile);
  let newStreak = streakData.streak;
  const todayStr = new Date().toISOString().split('T')[0];

  // Calculate if the streak should increase
  if (!profile?.last_active_date) {
    newStreak = 1;
  } else if (streakData.diffDays === 1) {
    newStreak += 1; // Logged in yesterday, streak goes up!
  } else if (streakData.diffDays > 1) {
    newStreak = 1; // Missed a day, streak resets
  }
  // If diffDays === 0, newStreak stays the same (they already increased it today)

  await pool.query(
    `UPDATE profile 
     SET xp = xp + $1, 
         waste_kg = waste_kg + $2, 
         co2_kg = co2_kg + $3, 
         water_l = CAST(COALESCE(NULLIF(water_l, ''), '0') AS INTEGER) + $4,
         streak = $5,
         last_active_date = $6
     WHERE id = $7`,
     [xpToAdd, wasteKg, co2Kg, waterL, newStreak, todayStr, userId]
  );
}

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    await pool.query('UPDATE quests SET completed = 0 WHERE last_completed_date != $1', [todayStr]);

    // Use req.user.id from the auth middleware
    const profileRes = await pool.query('SELECT * FROM profile WHERE id = $1', [req.user.id]);
    const user = profileRes.rows[0];

    const streakData = evaluateStreak(user);

    if (streakData.streak !== user?.streak) {
      await pool.query('UPDATE profile SET streak = $1 WHERE id = $2', [streakData.streak, req.user.id]);
    }

    const questsRes = await pool.query('SELECT * FROM quests ORDER BY id ASC');
    res.json({ user: { ...user, streak: streakData.streak, multiplier: streakData.multiplier }, quests: questsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim Quest
app.post('/api/quests/toggle', authMiddleware, async (req, res) => {
  try {
    const { questId, completed } = req.body;
    const isDone = completed ? 1 : 0;
    const todayStr = new Date().toISOString().split('T')[0];

    const questRes = await pool.query('SELECT xp_reward, completed FROM quests WHERE id = $1', [questId]);
    const quest = questRes.rows[0];

    if (isDone && quest && quest.completed === 1) {
      return res.status(400).json({ error: 'Quest already claimed for today!' });
    }

    const rawXp = quest ? quest.xp_reward : (parseInt(req.body.xp, 10) || 15);

    // Replaced id = 1 with req.user.id
    const profileRes = await pool.query('SELECT xp, streak, last_active_date FROM profile WHERE id = $1', [req.user.id]);
    const profile = profileRes.rows[0];

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

    const earnedXp = Math.round(rawXp * streakData.multiplier);
    const xpChange = isDone ? earnedXp : -earnedXp;

    // Replaced id = 1 with req.user.id
   await addXpAndUpdateStreak(req.user.id, xpReward);

    await pool.query(
      'UPDATE quests SET completed = $1, last_completed_date = $2 WHERE id = $3',
      [isDone, isDone ? todayStr : '', questId]
    );

    // Replaced id = 1 with req.user.id
    const updatedUserRes = await pool.query('SELECT * FROM profile WHERE id = $1', [req.user.id]);
    res.json({ success: true, user: updatedUserRes.rows[0], earnedXp, multiplier: streakData.multiplier });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reports ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/// AI Waste Report
app.post('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { lat, lng, location, description, imageBase64 } = req.body;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location coordinates.' });
    }

    let severity = "Moderate Waste";
    let complaintDraft = `Official Waste Clearance Request:\nLocation: ${location || 'Coordinates ' + lat + ', ' + lng}\nDetails: ${description || 'Illegal garbage accumulation reported.'}\nPlease act immediately.`;

    if (imageBase64 || description) {
      const prompt = `You are a municipal civic assistant. Analyze this reported garbage hotspot (Description: "${description || 'None'}") and generate a JSON response matching:
{
  "severity": "High Biohazard" | "Plastic Accumulation" | "Drainage Blockage" | "General Litter",
  "complaint_draft": "A professional, polite 2-sentence complaint addressed to municipal sanitation authorities requesting quick clearance with the coordinates (${lat}, ${lng})."
}
Return ONLY valid JSON.`;

      let parts = [prompt];
      if (imageBase64) {
        parts.push({ inlineData: { data: imageBase64, mimeType: "image/jpeg" } });
      }

    const result = await model.generateContent({
      contents: [{ role: "user", parts: parts.map(p => typeof p === 'string' ? { text: p } : p) }],
      generationConfig: { responseMimeType: "application/json" }
    });
    const response = await result.response;
    
    const parsed = JSON.parse(response.text());
      severity = parsed.severity || severity;
      complaintDraft = parsed.complaint_draft || complaintDraft;
    }

    const insertRes = await pool.query(
      'INSERT INTO reports (lat, lng, location, description) VALUES ($1, $2, $3, $4) RETURNING id',
      [lat, lng, location || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`, `${severity} - ${description || 'Hotspot reported'}`]
    );

    // Replaced id = 1 with req.user.id
    await addXpAndUpdateStreak(req.user.id, 30, 3, 8, 300);

    res.json({ id: insertRes.rows[0].id, success: true, severity, complaintDraft, lat, lng });

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
});

// AI Waste Scanner
app.post('/api/ai/scan-waste', authMiddleware, async (req, res) => {
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
      inlineData: { data: imageBase64, mimeType: "image/jpeg" }
    };

    // Force JSON output at the SDK level
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
      generationConfig: { responseMimeType: "application/json" }
    });
    const response = await result.response;
    
    // No more regex replace needed!
    const parsedData = JSON.parse(response.text());

    // Replaced id = 1 with req.user.id
    await addXpAndUpdateStreak(req.user.id, 25, 1, 3, 120);

    res.json(parsedData);
  } catch (error) {
    console.error("Waste Scan Error:", error);
    res.status(500).json({ error: error.message || 'Failed to analyze item' });
  }
});

// AI Food Rescue
app.post('/api/ai/food-rescue', authMiddleware, async (req, res) => {
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
        inlineData: { data: imageBase64, mimeType: "image/jpeg" }
      });
    } else if (ingredients) {
      parts.push(`${prompt}\n\nAvailable Ingredients: ${ingredients}`);
    } else {
      return res.status(400).json({ error: 'Please enter ingredients or scan food items.' });
    }

    const result = await model.generateContent({
      contents: [{ role: "user", parts: parts.map(p => typeof p === 'string' ? { text: p } : p) }],
      generationConfig: { responseMimeType: "application/json" }
    });
    const response = await result.response;
    
    const parsedRecipe = JSON.parse(response.text());

    // Replaced id = 1 with req.user.id
    await addXpAndUpdateStreak(req.user.id, 20, 1, 2, 250);

    res.json(parsedRecipe);
  } catch (error) {
    console.error("Food Rescue Error:", error);
    res.status(500).json({ error: error.message || 'Failed to generate recipe' });
  }
});

// Profile Update
app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    // Replaced id = 1 with req.user.id
    // Replaced id = 1 with req.user.id
    await pool.query('UPDATE profile SET name = $1 WHERE id = $2', [name.trim(), req.user.id]);
    
    // ADD THIS: Keep the core users table in sync!
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.user.id]);
    res.json({ success: true, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dynamic Leaderboard
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  try {
    // Replaced id = 1 with req.user.id
    const userRes = await pool.query('SELECT name, xp, streak FROM profile WHERE id = $1', [req.user.id]);
    const currentUser = userRes.rows[0];

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

    const allHunters = [...mockHunters, currentHunter].sort((a, b) => b.xp - a.xp);
    res.json(allHunters);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Custom Quest Completion
app.post('/api/profile/quest', authMiddleware, async (req, res) => {
  try {
    const xpReward = parseInt(req.body.xp, 10) || 15;

    // Replaced id = 1 with req.user.id
    await pool.query('UPDATE profile SET xp = xp + $1, streak = streak + 1 WHERE id = $2', [xpReward, req.user.id]);
    const updatedUser = await pool.query('SELECT * FROM profile WHERE id = $1', [req.user.id]);

    res.json({ success: true, user: updatedUser.rows[0], addedXp: xpReward });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alias /dashboard.html to /index.html
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});