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

// Parse all available Gemini API keys
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

// Helper: Get model instance using round-robin rotation
function getGeminiModel() {
  if (apiKeys.length === 0) {
    throw new Error('No Gemini API keys configured.');
  }
  const key = apiKeys[currentKeyIndex % apiKeys.length];
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  
  const client = new GoogleGenerativeAI(key);
  return client.getGenerativeModel({ model: 'gemini-2.5-flash' });
}

// Helper: Run generation with automatic key fallback and exponential backoff on 429
async function generateContentWithFallback(contentsConfig, maxRetries = 2, initialDelayMs = 1500) {
  let lastError = null;
  const totalKeys = Math.max(apiKeys.length, 1);

  // 1. Try across all available API keys first
  for (let keyAttempt = 0; keyAttempt < totalKeys; keyAttempt++) {
    try {
      const activeModel = getGeminiModel();
      return await activeModel.generateContent(contentsConfig);
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));

      if (isRateLimit) {
        console.warn(`Gemini key rate-limited. Trying key ${keyAttempt + 2}/${totalKeys}...`);
        continue;
      }
      throw err; // Fail fast for invalid prompts or non-rate-limit errors
    }
  }

  // 2. If all keys hit rate limits, pause with exponential backoff before retrying
  for (let retry = 0; retry < maxRetries; retry++) {
    const delay = initialDelayMs * Math.pow(2, retry);
    console.warn(`All keys busy. Retrying in ${delay}ms (Attempt ${retry + 1}/${maxRetries})...`);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      const activeModel = getGeminiModel();
      return await activeModel.generateContent(contentsConfig);
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
      if (!isRateLimit) throw err;
    }
  }

  throw lastError;
}

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

// Database Initialization Function for Postgres (Neon)
async function initDB() {
  try {
    // Initialize users table
    await initializeUsersTable(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_cache (
        query_key TEXT PRIMARY KEY,
        response_json JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // 1. Profile Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'Nikhil',
        streak INTEGER DEFAULT 0,
        xp INTEGER DEFAULT 0,
        xp_max INTEGER DEFAULT 100,
        level TEXT DEFAULT 'Level 1 - Rookie Hunter',
        co2_kg INTEGER DEFAULT 0,
        water_l TEXT DEFAULT '0',
        waste_kg INTEGER DEFAULT 0,
        last_active_date TEXT DEFAULT ''
      );
    `);

    // Safe initial seed for user
    await pool.query(`
      INSERT INTO profile (id, name, streak, xp, xp_max, level, co2_kg, water_l, waste_kg, last_active_date)
      VALUES (1, 'Nikhil', 0, 0, 100, 'Level 1 - Rookie Hunter', 0, '0', 0, '')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 3. Reports Table
    await pool.query(`
  CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    city TEXT,
    lat REAL,
    lng REAL,
    location TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);
    // 3. Reports Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        city TEXT,
        lat REAL,
        lng REAL,
        location TEXT,
        description TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure columns exist on legacy tables
    await pool.query(`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id INTEGER;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS city TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
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
  VALUES ($1, $2, 0, 0, 600, 'Level 1 - Rookie Hunter', 0, '0', 0, '')
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

    // Fetch user profile stats (xp, streak, etc.)
    const profileRes = await pool.query('SELECT * FROM profile WHERE id = $1', [user.id]);
    const profile = profileRes.rows[0] || {};

    const token = generateToken({ id: user.id, email: user.email, name: user.name });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        city: user.city,
        created_at: user.created_at,
        xp: profile.xp || 0,
        streak: profile.streak || 0,
        co2_kg: profile.co2_kg || 0,
        waste_kg: profile.waste_kg || 0,
        water_l: profile.water_l || '0'
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

// ==================== DASHBOARD & QUEST ENDPOINTS ====================

function evaluateStreak(profile) {
  if (!profile || !profile.last_active_date) {
    return { streak: 0, multiplier: 1.0, diffDays: 999 };
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const lastDate = new Date(profile.last_active_date);
  const today = new Date(todayStr);
  const diffDays = Math.round((today - lastDate) / (1000 * 60 * 60 * 24));

  let currentStreak = profile.streak || 0;

  if (diffDays > 1) {
    currentStreak = 0;
  }

  let multiplier = 1.0;
  if (currentStreak >= 14) multiplier = 2.0;
  else if (currentStreak >= 7) multiplier = 1.5;
  else if (currentStreak >= 3) multiplier = 1.2;

  return { streak: currentStreak, multiplier, diffDays };
}

async function addXpAndUpdateStreak(userId, xpToAdd, wasteKg = 0, co2Kg = 0, waterL = 0) {
  const profileRes = await pool.query('SELECT streak, last_active_date FROM profile WHERE id = $1', [userId]);
  const profile = profileRes.rows[0];
  
  const streakData = evaluateStreak(profile);
  let newStreak = streakData.streak;
  const todayStr = new Date().toISOString().split('T')[0];

  if (!profile?.last_active_date) {
    newStreak = 1;
  } else if (streakData.diffDays === 1) {
    newStreak += 1;
  } else if (streakData.diffDays > 1) {
    newStreak = 1;
  }

  const updatedRes = await pool.query(
    `UPDATE profile 
     SET xp = xp + $1, 
         waste_kg = waste_kg + $2, 
         co2_kg = co2_kg + $3, 
         water_l = CAST(COALESCE(NULLIF(water_l, ''), '0') AS INTEGER) + $4,
         streak = $5,
         last_active_date = $6
     WHERE id = $7
     RETURNING *`,
     [xpToAdd, wasteKg, co2Kg, waterL, newStreak, todayStr, userId]
  );

  return updatedRes.rows[0];
}

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const profileRes = await pool.query('SELECT * FROM profile WHERE id = $1', [req.user.id]);
    const user = profileRes.rows[0];

    if (!user) return res.status(404).json({ error: 'User profile not found' });

    const streakData = evaluateStreak(user);

    if (streakData.streak !== user.streak) {
      await pool.query('UPDATE profile SET streak = $1 WHERE id = $2', [streakData.streak, req.user.id]);
      user.streak = streakData.streak;
    }

    res.json({
      user: {
        ...user,
        streak: streakData.streak,
        multiplier: streakData.multiplier
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Active Hotspot Reports (Last 24 hours, Not Cleaned)
app.get('/api/reports', authMiddleware, async (req, res) => {
  try {
    // 1. Ensure the status column exists
    await pool.query(`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    `);

    // 2. Query pending or newly created (NULL status) reports within 24 hours
    const query = `
      SELECT * FROM reports 
      WHERE (status IS NULL OR status = 'pending' OR status != 'cleaned')
        AND created_at >= NOW() - INTERVAL '24 HOURS'
      ORDER BY id DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch reports error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit AI Waste Report
// AI Waste Report
app.post('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { lat, lng, location, description, imageBase64 } = req.body;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location coordinates.' });
    }

    // Auto-migrate columns if missing
    await pool.query(`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id INTEGER;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    `);

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

      try {
        const result = await generateContentWithFallback({
  contents: [{ role: "user", parts: parts.map(p => typeof p === 'string' ? { text: p } : p) }],
  generationConfig: { responseMimeType: "application/json" }
});
        const response = await result.response;
        const parsed = JSON.parse(response.text());
        severity = parsed.severity || severity;
        complaintDraft = parsed.complaint_draft || complaintDraft;
      } catch (aiErr) {
        console.warn('Gemini report analysis fallback:', aiErr.message);
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO reports (user_id, lat, lng, location, description, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [req.user.id, lat, lng, location || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`, `${severity} - ${description || 'Hotspot reported'}`]
    );

    const updatedProfile = await addXpAndUpdateStreak(req.user.id, 50, 3, 8, 300);

    res.json({ 
      id: insertRes.rows[0].id, 
      success: true, 
      severity, 
      complaintDraft, 
      lat, 
      lng,
      user: updatedProfile 
    });

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
});
// Mark Waste as Cleaned (+40 XP)
app.post('/api/reports/:id/clean', authMiddleware, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!reportId) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    // 1. Ensure status column exists in PostgreSQL
    await pool.query(`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    `);

    // 2. Mark this report as cleaned
    await pool.query('UPDATE reports SET status = $1 WHERE id = $2', ['cleaned', reportId]);

    // 3. Award +40 XP, +5 kg waste, +12 kg CO2, +400 L water saved
    const updatedProfile = await addXpAndUpdateStreak(req.user.id, 40, 5, 12, 400);

    res.json({
      success: true,
      message: 'Waste marked as cleaned!',
      user: updatedProfile
    });
  } catch (err) {
    console.error('Clean report error:', err);
    res.status(500).json({ error: err.message || 'Server error marking report cleaned' });
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
    const result = await generateContentWithFallback({
  contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
  generationConfig: { responseMimeType: "application/json" }
});
    const response = await result.response;
    
    // No more regex replace needed!
    const parsedData = JSON.parse(response.text());

   // Capture the updated profile from the helper function
const updatedProfile = await addXpAndUpdateStreak(req.user.id, 25, 1, 3, 120);

// Return parsedData along with the updated user profile
res.json({
  ...parsedData,
  user: updatedProfile
});
  } catch (error) {
    console.error("Waste Scan Error:", error);
    res.status(500).json({ error: error.message || 'Failed to analyze item' });
  }
});

// AI Food Rescue with Caching
app.post('/api/ai/food-rescue', authMiddleware, async (req, res) => {
  try {
    const { ingredients, imageBase64 } = req.body;
    let parts = [];

    // 1. If text ingredients are provided, check the cache first
    let cacheKey = null;
    if (ingredients && !imageBase64) {
      cacheKey = ingredients.toLowerCase().split(',').map(s => s.trim()).sort().join(',');
      const cached = await pool.query('SELECT response_json FROM scan_cache WHERE query_key = $1', [cacheKey]);
      
      if (cached.rows.length > 0) {
        // Cache hit: Return cached recipe and skip Gemini API call!
        const updatedProfile = await addXpAndUpdateStreak(req.user.id, 20, 1, 2, 250);
        return res.json({
          ...cached.rows[0].response_json,
          user: updatedProfile
        });
      }
    }

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

    const result = await generateContentWithFallback({
  contents: [{ role: "user", parts: parts.map(p => typeof p === 'string' ? { text: p } : p) }],
  generationConfig: { responseMimeType: "application/json" }
});
    const response = await result.response;
    const parsedRecipe = JSON.parse(response.text());

    // 2. Save result to database cache if it was a text query
    if (cacheKey) {
      await pool.query(
        'INSERT INTO scan_cache (query_key, response_json) VALUES ($1, $2) ON CONFLICT (query_key) DO NOTHING',
        [cacheKey, parsedRecipe]
      );
    }

    const updatedProfile = await addXpAndUpdateStreak(req.user.id, 20, 1, 2, 250);

    res.json({
      ...parsedRecipe,
      user: updatedProfile
    });
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

// Real Users Dynamic Leaderboard
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  try {
    const filter = req.query.filter || 'global';
    const currentUserId = req.user.id;

    // Fetch user's registered city
    const userRes = await pool.query('SELECT city FROM users WHERE id = $1', [currentUserId]);
    const userCity = userRes.rows[0]?.city;

    let queryText = `
      SELECT 
        u.id,
        u.name,
        u.city,
        COALESCE(p.xp, 0) AS xp,
        COALESCE(p.streak, 0) AS streak
      FROM users u
      LEFT JOIN profile p ON u.id = p.id
    `;
    const params = [];

    if (filter === 'city' && userCity) {
      queryText += ` WHERE LOWER(TRIM(u.city)) = LOWER(TRIM($1))`;
      params.push(userCity);
    }

    queryText += ` ORDER BY COALESCE(p.xp, 0) DESC, u.id ASC LIMIT 50`;

    const result = await pool.query(queryText, params);

    const hunters = result.rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      name: row.name,
      city: row.city,
      xp: parseInt(row.xp, 10) || 0,
      streak: parseInt(row.streak, 10) || 0,
      avatar: (row.name || 'H').charAt(0).toUpperCase(),
      isCurrent: row.id === currentUserId
    }));

    res.json(hunters);
  } catch (err) {
    console.error('Leaderboard error:', err);
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