import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { MongoClient, Db, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { 
    createSession, 
    getSession,
    getSessionByUsername,
    deleteSession, 
    executeCombatTurn,
    updateSession,
    updateEnemyPlans,
    markSessionConnected,
    markSessionDisconnected,
    initCombatSessionDB,
    CombatEngine,
    type CombatAction,
    type CombatSession
} from './combat-engine';
import { CombatWebSocketManager } from './websocket-manager';

// Load environment variables from .env file
dotenv.config();

// Define the expected structure for clarity
interface DialogueLine {
    speaker: string;
    text: string;
}
type DialoguePair = [DialogueLine[]] | [DialogueLine[], DialogueLine[]];
interface ChapterDialogue {
    dialogue: DialoguePair[];
}

// Account interface for MongoDB
interface ChapterProgress {
    unlocked: boolean;
    completed: boolean;
    currentLevel: number; // Highest level unlocked (1-based)
    levelsCompleted: number; // Total levels completed in this chapter
    totalLevels: number; // Total number of levels in this chapter
    savedProgress: {
        level: number;
        battleIndex: number;
        pcHealth: Record<string, number>;
        enemiesDefeated: string[];
        savedAt: Date;
    } | null;
    characterLevels: [number, number, number, number, number];
    inventory: {
        currency: number;
        pulls: number;
        unlockedAbilities: string[]; // Legacy: list of ability names
        abilityInventory: Record<string, number>; // New: ability name -> count (max 5)
    };
}

interface Account {
    _id?: ObjectId;
    username: string;
    email: string;
    passwordHash: string;
    createdAt: Date;
    lastLogin: Date;
    chapters: Record<string, ChapterProgress>;
    currentChapter: number;
    stats: {
        totalBattles: number;
        wins: number;
        losses: number;
        totalDamageDealt: number;
        totalHealingDone: number;
    };
    settings: {
        soundEnabled: boolean;
        musicVolume: number;
        sfxVolume: number;
        autoSpeed: number;
    };
}

// Helper function to get default chapter progress structure
function getDefaultChapterProgress(chapterNum: number = 1, unlocked: boolean = true): ChapterProgress {
    return {
        unlocked,
        completed: false,
        currentLevel: 1,
        levelsCompleted: 0,
        totalLevels: 10,
        savedProgress: null,
        characterLevels: [1, 1, 1, 1, 1],
        inventory: {
            currency: 1000,
            pulls: 10,
            unlockedAbilities: [],
            abilityInventory: {}
        }
    };
}

// Helper function to ensure account has all required fields (schema migration)
async function ensureAccountSchema(account: Account): Promise<{ updated: boolean; updates: Record<string, any> }> {
    const updates: Record<string, any> = {};
    
    // Ensure chapters exists and has chapter 1
    if (!account.chapters) {
        updates['chapters'] = { "1": getDefaultChapterProgress(1, true) };
    } else {
        // Ensure chapter 1 exists
        if (!account.chapters["1"]) {
            updates['chapters.1'] = getDefaultChapterProgress(1, true);
        } else {
            // Ensure all chapter fields exist
            const ch1 = account.chapters["1"];
            if (ch1.unlocked === undefined) updates['chapters.1.unlocked'] = true;
            if (ch1.completed === undefined) updates['chapters.1.completed'] = false;
            if (ch1.currentLevel === undefined) updates['chapters.1.currentLevel'] = 1;
            if (ch1.levelsCompleted === undefined) updates['chapters.1.levelsCompleted'] = 0;
            if (ch1.totalLevels === undefined) updates['chapters.1.totalLevels'] = 10;
            if (ch1.savedProgress === undefined) updates['chapters.1.savedProgress'] = null;
            if (!ch1.characterLevels) updates['chapters.1.characterLevels'] = [1, 1, 1, 1, 1];
            if (!ch1.inventory) {
                updates['chapters.1.inventory'] = { currency: 1000, pulls: 10, unlockedAbilities: [] };
            } else {
                if (ch1.inventory.currency === undefined) updates['chapters.1.inventory.currency'] = 1000;
                if (ch1.inventory.pulls === undefined) updates['chapters.1.inventory.pulls'] = 10;
                if (!ch1.inventory.unlockedAbilities) updates['chapters.1.inventory.unlockedAbilities'] = [];
            }
        }
    }
    
    // Ensure currentChapter exists
    if (account.currentChapter === undefined) {
        updates['currentChapter'] = 1;
    }
    
    // Ensure stats exists with all fields
    if (!account.stats) {
        updates['stats'] = {
            totalBattles: 0,
            wins: 0,
            losses: 0,
            totalDamageDealt: 0,
            totalHealingDone: 0
        };
    } else {
        if (account.stats.totalBattles === undefined) updates['stats.totalBattles'] = 0;
        if (account.stats.wins === undefined) updates['stats.wins'] = 0;
        if (account.stats.losses === undefined) updates['stats.losses'] = 0;
        if (account.stats.totalDamageDealt === undefined) updates['stats.totalDamageDealt'] = 0;
        if (account.stats.totalHealingDone === undefined) updates['stats.totalHealingDone'] = 0;
    }
    
    // Ensure settings exists with all fields
    if (!account.settings) {
        updates['settings'] = {
            soundEnabled: true,
            musicVolume: 0.8,
            sfxVolume: 1.0,
            autoSpeed: 1
        };
    } else {
        if (account.settings.soundEnabled === undefined) updates['settings.soundEnabled'] = true;
        if (account.settings.musicVolume === undefined) updates['settings.musicVolume'] = 0.8;
        if (account.settings.sfxVolume === undefined) updates['settings.sfxVolume'] = 1.0;
        if (account.settings.autoSpeed === undefined) updates['settings.autoSpeed'] = 1;
    }
    
    // Ensure createdAt and lastLogin exist
    if (!account.createdAt) updates['createdAt'] = new Date();
    if (!account.lastLogin) updates['lastLogin'] = new Date();
    
    return { updated: Object.keys(updates).length > 0, updates };
}

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'internet_explorers';
let db: Db;

async function connectToMongo() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log(`Connected to MongoDB: ${DB_NAME}`);
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

// Middleware
app.use(express.json());

// --- Maintenance mode check ---
function isMaintenanceMode(): boolean {
    try {
        const fs = require('fs');
        const killswitchPath = path.join(process.cwd(), 'static', 'killswitch.json');
        const data = fs.readFileSync(killswitchPath, 'utf-8');
        const killswitch = JSON.parse(data);
        return killswitch.maintenance_mode === true;
    } catch (e) {
        console.warn('Could not read killswitch.json:', e);
    }
    return false;
}

// Middleware to block new game actions during maintenance (but allow ongoing combats)
function maintenanceGuard(req: Request, res: Response, next: NextFunction) {
    if (!isMaintenanceMode()) {
        return next();
    }
    
    // Check if this is an API request or page request
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({ 
            error: 'Maintenance mode is active. Please try again later.',
            maintenance: true 
        });
    }
    
    // For page requests, serve the maintenance page
    return res.sendFile(path.join(process.cwd(), 'public', 'maintenance.html'));
}

// --- Admin HTTP Basic Auth middleware ---
function checkAdminAuth(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
        return res.status(401).send('Unauthorized');
    }

    try {
        const parts = auth.split(' ');
        const encoded = parts[1] || '';
        if (!encoded) {
            throw new Error('Invalid Authorization header');
        }
        const creds = Buffer.from(encoded, 'base64').toString('utf8');
        const [user, pass] = creds.split(':');
        const adminUser = process.env.ADMIN_USER || 'admin';
        const adminPass = process.env.ADMIN_PASS || 'changeme';

        if (user === adminUser && pass === adminPass) {
            return next();
        }
    } catch (e) {
        // fall through to unauthorized
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Unauthorized');
}

//this is temporary until we set up proper routing
//app.use(express.static(path.join(process.cwd(), 'public')));

// Simple health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API to check maintenance status
app.get('/api/maintenance', (_req: Request, res: Response) => {
    try {
        const fs = require('fs');
        const killswitchPath = path.join(process.cwd(), 'static', 'killswitch.json');
        const data = fs.readFileSync(killswitchPath, 'utf-8');
        const killswitch = JSON.parse(data);
        const statusKey = killswitch.maintenance_status || 'updating';
        const statuses = killswitch.maintenance_statuses || {};
        const statusMessage = statuses[statusKey] || statusKey;
        const devMessage = killswitch.maintenance_message || null;
        return res.json({ 
            maintenance: killswitch.maintenance_mode === true,
            status: statusKey,
            message: statusMessage,
            devMessage: devMessage
        });
    } catch (e) {
        console.warn('Could not read killswitch for maintenance API:', e);
    }
    res.json({ maintenance: false, status: null, message: null, devMessage: null });
});

// Serve admin UI (protected by Basic Auth)
app.get('/admin', checkAdminAuth, (req: Request, res: Response) => {
    return res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// Admin API: list all accounts
app.get('/api/admin/accounts', checkAdminAuth, async (_req: Request, res: Response) => {
    try {
        const accounts = await db.collection('accounts').find({}).toArray();
        return res.json(accounts);
    } catch (e) {
        console.error('Failed to fetch accounts:', e);
        return res.status(500).json({ error: 'Failed to fetch accounts' });
    }
});

// Admin API: get single account
app.get('/api/admin/account/:username', checkAdminAuth, async (req: Request, res: Response) => {
    try {
        const username = req.params.username;
        const account = await db.collection('accounts').findOne({ username });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        return res.json(account);
    } catch (e) {
        console.error('Failed to fetch account:', e);
        return res.status(500).json({ error: 'Failed to fetch account' });
    }
});

// Admin API: update account (partial)
app.post('/api/admin/update-account', checkAdminAuth, async (req: Request, res: Response) => {
    try {
        const { username, updates } = req.body;
        if (!username || !updates) return res.status(400).json({ error: 'username and updates required' });

        // Prevent _id modification
        if (updates._id) delete updates._id;

        const result = await db.collection('accounts').updateOne({ username }, { $set: updates });
        return res.json({ matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e) {
        console.error('Failed to update account:', e);
        return res.status(500).json({ error: 'Failed to update account' });
    }
});

// Admin API: bulk updates array of { filter, update } operations
app.post('/api/admin/bulk-update', checkAdminAuth, async (req: Request, res: Response) => {
    try {
        const ops = req.body.operations;
        if (!Array.isArray(ops)) return res.status(400).json({ error: 'operations array required' });

        const results: any[] = [];
        for (const op of ops) {
            if (!op.filter || !op.update) {
                results.push({ ok: false, reason: 'missing filter/update' });
                continue;
            }
            const r = await db.collection('accounts').updateMany(op.filter, op.update);
            results.push({ matched: r.matchedCount, modified: r.modifiedCount });
        }

        return res.json({ results });
    } catch (e) {
        console.error('Bulk update failed:', e);
        return res.status(500).json({ error: 'Bulk update failed' });
    }
});

// ==================== ACCOUNT API ROUTES ====================

// Register a new account
app.post('/api/accounts/register', async (req: Request, res: Response) => {
    try {
        const { username, email, password } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required.' });
        }
        
        // Check if username or email already exists
        const existing = await db.collection<Account>('accounts').findOne({
            $or: [{ username }, { email }]
        });
        
        if (existing) {
            return res.status(409).json({ error: 'Username or email already exists.' });
        }
        
        // In production, use bcrypt to hash the password
        // For now, we'll store a placeholder (DO NOT use in production)
        const newAccount: Account = {
            username,
            email,
            passwordHash: `hashed_${password}`, // Replace with bcrypt.hash(password, 10)
            createdAt: new Date(),
            lastLogin: new Date(),
            chapters: {
                "1": {
                    unlocked: true,
                    completed: false,
                    currentLevel: 1,
                    levelsCompleted: 0,
                    totalLevels: 10,
                    savedProgress: null,
                    characterLevels: [1, 1, 1, 1, 1],
                    inventory: {
                        currency: 1000,
                        pulls: 10,
                        unlockedAbilities: []
                    }
                }
            },
            currentChapter: 1,
            stats: {
                totalBattles: 0,
                wins: 0,
                losses: 0,
                totalDamageDealt: 0,
                totalHealingDone: 0
            },
            settings: {
                soundEnabled: true,
                musicVolume: 0.8,
                sfxVolume: 1.0,
                autoSpeed: 1
            }
        };
        
        const result = await db.collection<Account>('accounts').insertOne(newAccount);
        return res.status(201).json({ 
            message: 'Account created successfully.',
            accountId: result.insertedId 
        });
    } catch (error) {
        console.error('Registration error:', error);
        return res.status(500).json({ error: 'Failed to create account.' });
    }
});

// Login
app.post('/api/accounts/login', async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }
        
        const account = await db.collection<Account>('accounts').findOne({ username });
        
        if (!account) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        
        // In production, use bcrypt.compare(password, account.passwordHash)
        if (account.passwordHash !== `hashed_${password}`) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        
        // Ensure account has all required fields (schema migration)
        const { updated, updates } = await ensureAccountSchema(account);
        const updateObj: Record<string, any> = { lastLogin: new Date(), ...updates };
        
        // Update last login and any missing fields
        await db.collection<Account>('accounts').updateOne(
            { _id: account._id },
            { $set: updateObj }
        );
        
        // Fetch the updated account if there were schema updates
        let finalAccount = account;
        if (updated) {
            const refreshed = await db.collection<Account>('accounts').findOne({ _id: account._id });
            if (refreshed) finalAccount = refreshed;
            console.log(`Account ${username} schema updated with missing fields:`, Object.keys(updates));
        }
        
        // Return account data (excluding password hash)
        const { passwordHash, ...safeAccount } = finalAccount;
        return res.json({ 
            message: 'Login successful.',
            account: safeAccount 
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Login failed.' });
    }
});

// Get account by username
app.get('/api/accounts/:username', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        let account = await db.collection<Account>('accounts').findOne({ username });
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        // Ensure account has all required fields (schema migration)
        const { updated, updates } = await ensureAccountSchema(account);
        if (updated) {
            await db.collection<Account>('accounts').updateOne(
                { _id: account._id },
                { $set: updates }
            );
            // Refresh the account data
            const refreshed = await db.collection<Account>('accounts').findOne({ _id: account._id });
            if (refreshed) account = refreshed;
            console.log(`Account ${username} schema updated with missing fields:`, Object.keys(updates));
        }
        
        // Return account data (excluding password hash)
        const { passwordHash, ...safeAccount } = account;
        return res.json({ account: safeAccount });
    } catch (error) {
        console.error('Get account error:', error);
        return res.status(500).json({ error: 'Failed to retrieve account.' });
    }
});

// Update account progress (chapter-based)
app.patch('/api/accounts/:username/progress', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const { chapter, currentChapter, completed, savedProgress } = req.body;
        
        const updateObj: any = {};
        
        // Update current chapter globally
        if (currentChapter !== undefined) {
            updateObj['currentChapter'] = currentChapter;
        }
        
        // Update specific chapter data
        if (chapter !== undefined) {
            const chapterKey = String(chapter);
            
            if (completed !== undefined) {
                updateObj[`chapters.${chapterKey}.completed`] = completed;
                
                // If completing a chapter, unlock the next one
                if (completed === true) {
                    const nextChapter = String(chapter + 1);
                    updateObj[`chapters.${nextChapter}.unlocked`] = true;
                    // Initialize next chapter if it doesn't exist
                    updateObj[`chapters.${nextChapter}.completed`] = { $ifNull: [`$chapters.${nextChapter}.completed`, false] };
                }
            }
            
            if (savedProgress !== undefined) {
                if (savedProgress === null) {
                    updateObj[`chapters.${chapterKey}.savedProgress`] = null;
                } else {
                    updateObj[`chapters.${chapterKey}.savedProgress`] = {
                        ...savedProgress,
                        savedAt: new Date()
                    };
                }
            }
        }
        
        if (Object.keys(updateObj).length === 0) {
            return res.status(400).json({ error: 'No progress updates provided.' });
        }
        
        const result = await db.collection<Account>('accounts').updateOne(
            { username },
            { $set: updateObj }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        return res.json({ message: 'Progress updated successfully.' });
    } catch (error) {
        console.error('Update progress error:', error);
        return res.status(500).json({ error: 'Failed to update progress.' });
    }
});

// Get level progress for a specific chapter
app.get('/api/accounts/:username/levels/:chapter', async (req: Request, res: Response) => {
    try {
        const { username, chapter } = req.params;
        const chapterKey = String(chapter);
        const chapterNum = parseInt(chapter || '1');
        
        const account = await db.collection<Account>('accounts').findOne({ username });
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        const chapterData = account.chapters[chapterKey];
        
        if (!chapterData) {
            return res.status(404).json({ error: 'Chapter not found or not unlocked.' });
        }
        
        return res.json({
            chapter: chapterNum,
            unlocked: chapterData.unlocked,
            currentLevel: chapterData.currentLevel || 1,
            levelsCompleted: chapterData.levelsCompleted || 0,
            totalLevels: chapterData.totalLevels || 10
        });
    } catch (error) {
        console.error('Get level progress error:', error);
        return res.status(500).json({ error: 'Failed to get level progress.' });
    }
});

// Complete a level - unlocks the next level
app.post('/api/accounts/:username/levels/:chapter/:level/complete', async (req: Request, res: Response) => {
    try {
        const { username, chapter, level } = req.params;
        const chapterKey = String(chapter);
        const chapterNum = parseInt(chapter || '1');
        const levelNum = parseInt(level || '1');
        
        const account = await db.collection<Account>('accounts').findOne({ username });
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        const chapterData = account.chapters[chapterKey];
        
        if (!chapterData || !chapterData.unlocked) {
            return res.status(403).json({ error: 'Chapter not unlocked.' });
        }
        
        const currentLevel = chapterData.currentLevel || 1;
        const totalLevels = chapterData.totalLevels || 10;
        
        // Only allow completing the current level or earlier (replaying)
        if (levelNum > currentLevel) {
            return res.status(403).json({ error: 'Level not unlocked yet.' });
        }
        
        const setObj: any = {};
        const incObj: any = {};

        // If completing a new level (not replaying)
        if (levelNum === currentLevel) {
            setObj[`chapters.${chapterKey}.levelsCompleted`] = levelNum;

            // If there are more levels, unlock the next one
            if (levelNum < totalLevels) {
                setObj[`chapters.${chapterKey}.currentLevel`] = levelNum + 1;
            } else {
                // Chapter completed!
                setObj[`chapters.${chapterKey}.completed`] = true;

                // Unlock next chapter
                const nextChapterKey = String(chapterNum + 1);
                setObj[`chapters.${nextChapterKey}`] = {
                    unlocked: true,
                    completed: false,
                    currentLevel: 1,
                    levelsCompleted: 0,
                    totalLevels: getChapterLevelCount(chapterNum + 1),
                    savedProgress: null,
                    characterLevels: [1, 1, 1, 1, 1],
                    inventory: {
                        currency: 1000,
                        pulls: 10,
                        unlockedAbilities: []
                    }
                };
            }
        }

        // Update stats (use $inc)
        incObj['stats.totalBattles'] = 1;
        incObj['stats.wins'] = 1;

        // Reward for clearing a level: use leveling.json config
        const previouslyCleared = (chapterData.levelsCompleted || 0) >= levelNum;
        const reward = getLevelReward(chapterNum, levelNum, previouslyCleared);

        // Add reward to chapter inventory
        incObj[`chapters.${chapterKey}.inventory.currency`] = reward;

        const updateOps: any = {};
        if (Object.keys(setObj).length) updateOps.$set = setObj;
        if (Object.keys(incObj).length) updateOps.$inc = incObj;

        await db.collection<Account>('accounts').updateOne({ username }, updateOps);
        
        const isChapterComplete = levelNum >= totalLevels;
        const nextLevel = levelNum < totalLevels ? levelNum + 1 : null;
        
        return res.json({
            message: 'Level completed!',
            levelCompleted: levelNum,
            nextLevel,
            chapterCompleted: isChapterComplete,
            nextChapterUnlocked: isChapterComplete ? chapterNum + 1 : null
        });
    } catch (error) {
        console.error('Complete level error:', error);
        return res.status(500).json({ error: 'Failed to complete level.' });
    }
});

// Cache for chapter level counts (read from static/story/enemy/ch*.json)
const chapterLevelCountCache: Record<number, number> = {};

// Leveling config cache
let levelingConfig: any = null;

// Helper function to get the leveling config (rewards and costs)
function getLevelingConfig() {
    if (levelingConfig) return levelingConfig;
    try {
        const fs = require('fs');
        const filePath = path.join(__dirname, 'static', 'story', 'leveling.json');
        if (fs.existsSync(filePath)) {
            levelingConfig = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return levelingConfig;
        }
    } catch (e) {
        console.warn('Could not read leveling config:', e);
    }
    // Fallback defaults
    return {
        levelUpCost: { base: 100, increment: 50 },
        levelRewards: { default: [200, 100, 50] },
        bossLevelRewards: { overrides: {} }
    };
}

// Helper function to calculate level-up cost for a given current level
function getLevelUpCost(currentLevel: number): number {
    const config = getLevelingConfig();
    const base = config.levelUpCost?.base || 100;
    const increment = config.levelUpCost?.increment || 50;
    // cost = base + increment * (currentLevel - 1) => 100, 150, 200, 250...
    return base + increment * (currentLevel - 1);
}

// Helper function to get level completion reward
function getLevelReward(chapter: number, level: number, previouslyCleared: boolean): number {
    const config = getLevelingConfig();
    const levelKey = `${chapter}-${level}`;
    
    // Check for override first (can be number or array)
    const overrides = config.levelRewards?.overrides || config.bossLevelRewards?.overrides || {};
    const override = overrides[levelKey];
    
    let rewardTiers: number[];
    if (override !== undefined && override !== null) {
        // Override can be a number (flat reward for all clears) or array (like default)
        if (Array.isArray(override)) {
            rewardTiers = override;
        } else if (typeof override === 'number') {
            rewardTiers = [override]; // Single value = same for all clears
        } else {
            rewardTiers = config.levelRewards?.default || [200, 100, 50];
        }
    } else {
        // Use default reward tiers
        rewardTiers = config.levelRewards?.default || [200, 100, 50];
    }
    
    // Determine reward based on clear count (first clear = index 0, etc.)
    // For simplicity, previouslyCleared means at least 1 clear, so use index 1+
    let reward: number;
    if (!previouslyCleared) {
        // First clear
        reward = rewardTiers[0] || 50;
    } else {
        // Subsequent clears - use last tier value
        reward = rewardTiers[rewardTiers.length - 1] || 50;
    }
    
    return reward;
}

// Helper function to get the number of levels per chapter (reads from story/enemy json files)
function getChapterLevelCount(chapter: number): number {
    // Return cached value if available
    if (chapterLevelCountCache[chapter] !== undefined) {
        return chapterLevelCountCache[chapter];
    }
    
    // Try to read from the story/enemy json file
    try {
        const fs = require('fs');
        const filePath = path.join(__dirname, 'static', 'story', 'enemy', `ch${chapter}.json`);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const levelCount = data.levels?.length || 10;
            chapterLevelCountCache[chapter] = levelCount;
            return levelCount;
        }
    } catch (e) {
        console.warn(`Could not read level count for chapter ${chapter}:`, e);
    }
    
    // Fallback to default
    return 10;
}

// Update account stats (after battle)
app.patch('/api/accounts/:username/stats', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const { won, damageDealt, healingDone } = req.body;
        
        const incObj: any = {
            'stats.totalBattles': 1
        };
        
        if (won === true) {
            incObj['stats.wins'] = 1;
        } else if (won === false) {
            incObj['stats.losses'] = 1;
        }
        
        if (damageDealt) {
            incObj['stats.totalDamageDealt'] = damageDealt;
        }
        
        if (healingDone) {
            incObj['stats.totalHealingDone'] = healingDone;
        }
        
        const result = await db.collection<Account>('accounts').updateOne(
            { username },
            { $inc: incObj }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        return res.json({ message: 'Stats updated successfully.' });
    } catch (error) {
        console.error('Update stats error:', error);
        return res.status(500).json({ error: 'Failed to update stats.' });
    }
});

// Update chapter inventory (currency, pulls, abilities)
app.patch('/api/accounts/:username/inventory', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const { chapter, currencyDelta, pullsDelta, newAbility } = req.body;
        
        if (chapter === undefined) {
            return res.status(400).json({ error: 'Chapter number is required.' });
        }
        
        const chapterKey = String(chapter);
        const updateOps: any = {};
        
        if (currencyDelta !== undefined || pullsDelta !== undefined) {
            updateOps.$inc = {};
            if (currencyDelta !== undefined) {
                updateOps.$inc[`chapters.${chapterKey}.inventory.currency`] = currencyDelta;
            }
            if (pullsDelta !== undefined) {
                updateOps.$inc[`chapters.${chapterKey}.inventory.pulls`] = pullsDelta;
            }
        }
        
        if (newAbility) {
            updateOps.$addToSet = { [`chapters.${chapterKey}.inventory.unlockedAbilities`]: newAbility };
        }
        
        if (Object.keys(updateOps).length === 0) {
            return res.status(400).json({ error: 'No inventory updates provided.' });
        }
        
        const result = await db.collection<Account>('accounts').updateOne(
            { username },
            updateOps
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        return res.json({ message: 'Inventory updated successfully.' });
    } catch (error) {
        console.error('Update inventory error:', error);
        return res.status(500).json({ error: 'Failed to update inventory.' });
    }
});

// Update account settings
app.patch('/api/accounts/:username/settings', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const { soundEnabled, musicVolume, sfxVolume, autoSpeed } = req.body;
        
        const updateObj: any = {};
        
        if (soundEnabled !== undefined) updateObj['settings.soundEnabled'] = soundEnabled;
        if (musicVolume !== undefined) updateObj['settings.musicVolume'] = musicVolume;
        if (sfxVolume !== undefined) updateObj['settings.sfxVolume'] = sfxVolume;
        if (autoSpeed !== undefined) updateObj['settings.autoSpeed'] = autoSpeed;
        
        if (Object.keys(updateObj).length === 0) {
            return res.status(400).json({ error: 'No settings updates provided.' });
        }
        
        const result = await db.collection<Account>('accounts').updateOne(
            { username },
            { $set: updateObj }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        
        return res.json({ message: 'Settings updated successfully.' });
    } catch (error) {
        console.error('Update settings error:', error);
        return res.status(500).json({ error: 'Failed to update settings.' });
    }
});

// Get chapter info (including level count from story/enemy json)
app.get('/api/chapters/:chapter', (req: Request, res: Response) => {
    try {
        const chapterNum = parseInt(req.params.chapter || '1');
        const levelCount = getChapterLevelCount(chapterNum);
        
        // Chapter metadata (can be expanded)
        const chapterMeta: Record<number, { title: string; subtitle: string }> = {
            1: { title: "Mindustry", subtitle: "Factory Defense" },
            2: { title: "Item Asylum", subtitle: "Chaos Unleashed" },
            3: { title: "Forsaken", subtitle: "Into the Void" },
            4: { title: "Die of Death", subtitle: "Asymmetrical Horror Game" },
            5: { title: "Phasmophobia", subtitle: "Ghost Hunt" },
            6: { title: "Forsaken Part 2", subtitle: "Return to the Void" },
            7: { title: "Project Sekai", subtitle: "Virtual Stage" },
            8: { title: "Limbus Company", subtitle: "Dante's Descent" },
            9: { title: "Battle Bricks", subtitle: "Block Warfare" },
            10: { title: "Recapitulation", subtitle: "The Final Chapter" }
        };
        
        const meta = chapterMeta[chapterNum] || { title: `Chapter ${chapterNum}`, subtitle: "Unknown" };
        
        return res.json({
            chapter: chapterNum,
            title: meta.title,
            subtitle: meta.subtitle,
            levels: levelCount
        });
    } catch (error) {
        console.error('Get chapter info error:', error);
        return res.status(500).json({ error: 'Failed to get chapter info.' });
    }
});

// ==================== END ACCOUNT API ROUTES ====================

// Page routes

// Maintenance page (always accessible)
app.get('/maintenance', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

// All pages blocked during maintenance except /maintenance, /admin, and /combat.js (for ongoing battles)
app.get('/', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/dashboard', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/chapters', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'chapters.html'));
});

app.get('/levels', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'levels.html'));
});

app.get('/combat', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'combat.html'));
});

// combat.js always accessible (needed for ongoing battles)
app.get('/combat.js', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'combat.js'));
});

app.get('/gacha', maintenanceGuard, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'gacha.html'));
});

// API to get parameters from MongoDB
app.get('/api/getParameters', async (_req: Request, res: Response) => {
    try {
        const parametersCollection = db.collection('parameters');
        const parametersDocs = await parametersCollection.find({}).toArray();
        
        // Convert array of documents to object keyed by name
        const parameters: Record<string, any> = {};
        for (const doc of parametersDocs) {
            const { _id, name, ...rest } = doc;
            if (name) {
                parameters[name] = rest;
            }
        }
        
        // If no parameters in DB, fall back to static file
        if (Object.keys(parameters).length === 0) {
            try {
                const paramsPath = path.join(__dirname, 'static', 'params.json');
                const paramsData = require(paramsPath);
                return res.json({ parameters: paramsData });
            } catch (e) {
                return res.json({ parameters: {} });
            }
        }
        
        return res.json({ parameters });
    } catch (e: any) {
        console.error('Error loading parameters from MongoDB:', e);
        // Fall back to static file on error
        try {
            const paramsPath = path.join(__dirname, 'static', 'params.json');
            const paramsData = require(paramsPath);
            return res.json({ parameters: paramsData });
        } catch (fallbackError) {
            return res.status(500).json({ error: 'Failed to load parameters.' });
        }
    }
});

// API to get character data for a chapter and level (blocked during maintenance)
app.get('/api/getUnits', maintenanceGuard, async (req: Request, res: Response) => {
    const chapterNum = Number(req.query.ch) || 1;
    const levelNum = Number(req.query.lvl) || 1;
    const username = req.query.username as string | undefined;
    
    try {
        // Load character data
        const charsPath = path.join(__dirname, 'static', 'chars', `ch${chapterNum}.json`);
        const charsData = require(charsPath);
        
        // Load character abilities
        const charAbilitiesPath = path.join(__dirname, 'static', 'chars', 'abilities.json');
        const charAbilities = require(charAbilitiesPath);
        
        // Load enemy definitions for this chapter
        const enemiesPath = path.join(__dirname, 'static', 'enemies', `ch${chapterNum}.json`);
        const enemiesData = require(enemiesPath);
        
        // Load level configuration (which enemies appear in each level)
        const levelConfigPath = path.join(__dirname, 'static', 'story', 'enemy', `ch${chapterNum}.json`);
        const levelConfig = require(levelConfigPath);
        
        // Load enemy abilities
        const enemyAbilitiesPath = path.join(__dirname, 'static', 'enemies', 'abilities.json');
        const enemyAbilities = require(enemyAbilitiesPath);
        
        // Load enemy passives
        const passivesPath = path.join(__dirname, 'static', 'enemies', 'passives.json');
        const passives = require(passivesPath);
        
        // Build PC data with resolved abilities (optionally apply account levels)
        // If a username is provided, fetch their characterLevels and unlockedAbilities for this chapter
        let accountCharacterLevels: number[] | null = null;
        let unlockedAbilities: string[] = [];
        if (username) {
            try {
                const account = await db.collection<Account>('accounts').findOne({ username });
                if (account) {
                    const chapterKey = String(chapterNum);
                    const ch = account.chapters?.[chapterKey];
                    if (ch && Array.isArray(ch.characterLevels)) {
                        accountCharacterLevels = ch.characterLevels.slice();
                    }
                    // Get unlocked abilities for this chapter's inventory
                    if (ch?.inventory?.unlockedAbilities && Array.isArray(ch.inventory.unlockedAbilities)) {
                        unlockedAbilities = ch.inventory.unlockedAbilities;
                    }
                }
            } catch (e) {
                console.warn('Failed to load account for units leveling:', e);
            }
        }

        // Build PC data
        const PCs: Record<string, any> = {};
        for (const [name, data] of Object.entries(charsData as Record<string, any>)) {
            const abilityName = data.ability;
            const baseAbility = charAbilities[abilityName] || {};

            // Start from base ability values
            let damage = baseAbility.damage || 0;
            let heal = baseAbility.heal || 0;
            let minroll = baseAbility.minroll || 0;
            let rolls = baseAbility.rolls || 0;

            // Apply character level modifications if available
            if (accountCharacterLevels) {
                // Map characters to consistent index: assume order of Object.keys(charsData)
                const keys = Object.keys(charsData as Record<string, any>);
                const charIndex = keys.indexOf(name);
                const level = (charIndex >= 0 && accountCharacterLevels[charIndex]) ? accountCharacterLevels[charIndex] : 1;

                // Level progression pattern:
                // First triplet (levels 2..4):
                //  - step 1: +1 to max roll (`rolls`)
                //  - step 2: +2 to damage
                //  - step 3: +1 to min roll (`minroll`)
                // After that, repeat triplets where each triplet is:
                //  - step 1: +2 to max roll
                //  - step 2: +4 to damage
                //  - step 3: +1 to min roll
                // We iterate each level-up step (starting at 1 for level->level+1) and apply the appropriate change.

                const baseDamage = damage;
                const upgrades = level - 1; // number of level-up steps applied to reach `level` from 1
                for (let step = 1; step <= upgrades; step++) {
                    const tripletIndex = Math.floor((step - 1) / 3); // 0 = first special triplet, >=1 = repeated triplets
                    const pos = (step - 1) % 3; // 0 => roll increase, 1 => damage increase, 2 => minroll increase

                    if (pos === 0) {
                        // max roll increase
                        const addRolls = tripletIndex === 0 ? 1 : 2;
                        rolls = (rolls || 0) + addRolls;
                    } else if (pos === 1) {
                        // damage increase
                        const addDmg = tripletIndex === 0 ? 2 : 4;
                        damage += addDmg;
                    } else if (pos === 2) {
                        // min roll increase
                        minroll = (minroll || 0) + 1;
                    }
                }
            }

            // Determine character level
            let charLevel = 1;
            if (accountCharacterLevels) {
                const keys = Object.keys(charsData as Record<string, any>);
                const charIndex = keys.indexOf(name);
                charLevel = (charIndex >= 0 && accountCharacterLevels[charIndex]) ? accountCharacterLevels[charIndex] : 1;
            }

            // Build the primary ability
            const primaryAbility = {
                damage,
                heal,
                minroll,
                rolls,
                type: baseAbility.type || "Adaptive",
                effect: abilityName
            };

            // Build abilities array - start with primary ability
            const abilities = [primaryAbility];

            // Add unlocked abilities from the chapter's inventory
            for (const unlockedAbilityName of unlockedAbilities) {
                const unlockedAbilityData = charAbilities[unlockedAbilityName];
                if (unlockedAbilityData) {
                    // Apply the same level scaling to unlocked abilities
                    let uaDamage = unlockedAbilityData.damage || 0;
                    let uaHeal = unlockedAbilityData.heal || 0;
                    let uaMinroll = unlockedAbilityData.minroll || 0;
                    let uaRolls = unlockedAbilityData.rolls || 0;

                    // Apply character level modifications to unlocked abilities too
                    if (accountCharacterLevels) {
                        const keys = Object.keys(charsData as Record<string, any>);
                        const charIndex = keys.indexOf(name);
                        const level = (charIndex >= 0 && accountCharacterLevels[charIndex]) ? accountCharacterLevels[charIndex] : 1;
                        const upgrades = level - 1;
                        for (let step = 1; step <= upgrades; step++) {
                            const tripletIndex = Math.floor((step - 1) / 3);
                            const pos = (step - 1) % 3;
                            if (pos === 0) {
                                const addRolls = tripletIndex === 0 ? 1 : 2;
                                uaRolls = (uaRolls || 0) + addRolls;
                            } else if (pos === 1) {
                                const addDmg = tripletIndex === 0 ? 2 : 4;
                                uaDamage += addDmg;
                            } else if (pos === 2) {
                                uaMinroll = (uaMinroll || 0) + 1;
                            }
                        }
                    }

                    abilities.push({
                        damage: uaDamage,
                        heal: uaHeal,
                        minroll: uaMinroll,
                        rolls: uaRolls,
                        type: unlockedAbilityData.type || "Adaptive",
                        effect: unlockedAbilityName
                    });
                }
            }

            PCs[name] = {
                maxHp: data.maxHp,
                role: data.role,
                level: charLevel,
                ability: primaryAbility,
                abilities: abilities
            };
        }
        
        // Find the level configuration
        const levelData = levelConfig.levels.find((l: any) => l.level === levelNum);
        if (!levelData) {
            return res.status(404).json({ error: `Level ${levelNum} not found in chapter ${chapterNum}.` });
        }
        
        // Get enemy scaling config
        const levelingCfg = getLevelingConfig();
        const enemyScaling = levelingCfg.enemyScaling || { enabled: false };
        const scalingEnabled = enemyScaling.enabled !== false;
        const startLevel = enemyScaling.startLevel || 2;
        const perLevel = enemyScaling.perLevel || { hp: 5, damage: 1, rolls: 0.5 };
        
        // Calculate scaling multiplier based on level
        const scalingLevels = Math.max(0, levelNum - startLevel + 1);
        
        // Build enemy data for this specific level
        // Use unique keys for each enemy instance (e.g., "Dagger_0", "Dagger_1")
        const ENs: Record<string, any> = {};
        const enemyCount: Record<string, number> = {};
        
        for (const enemyName of levelData.enemies) {
            const enemyDef = enemiesData[enemyName];
            if (!enemyDef) {
                console.warn(`Enemy "${enemyName}" not found in chapter ${chapterNum} enemy definitions.`);
                continue;
            }
            
            // Track count for unique naming
            enemyCount[enemyName] = (enemyCount[enemyName] || 0) + 1;
            const uniqueKey = `${enemyName}_${enemyCount[enemyName]}`;
            
            // Support both single ability (legacy) and multiple abilities
            const abilityNames = enemyDef.abilities || (enemyDef.ability ? [enemyDef.ability] : []);
            const abilities = abilityNames.map((abilityName: string) => {
                const abilityData = enemyAbilities[abilityName] || {};
                let damage = abilityData.damage || 0;
                let minroll = abilityData.minroll || 0;
                let rolls = abilityData.rolls || 0;
                
                // Apply scaling if enabled
                if (scalingEnabled && scalingLevels > 0) {
                    damage += Math.floor(scalingLevels * (perLevel.damage || 0));
                    rolls += Math.floor(scalingLevels * (perLevel.rolls || 0));
                }
                
                return {
                    name: abilityName,
                    damage,
                    minroll,
                    rolls,
                    type: abilityData.type || "Rolling"
                };
            });
            
            const passiveNames = Object.keys(enemyDef.passives || {});
            
            // Apply HP scaling
            let maxHp = enemyDef.maxHp || 10;
            if (scalingEnabled && scalingLevels > 0) {
                maxHp += Math.floor(scalingLevels * (perLevel.hp || 0));
            }
            
            ENs[uniqueKey] = {
                maxHp,
                name: enemyDef.name,
                level: scalingEnabled ? Math.max(1, levelNum) : 1,
                // Keep 'ability' for backward compatibility (first ability)
                ability: abilities[0] || { damage: 0, minroll: 0, rolls: 0, type: "Rolling" },
                // Add 'abilities' array for multi-ability support
                abilities: abilities,
                passives: passiveNames
            };
        }
        
        return res.json({ PCs, ENs, passives, chapter: chapterNum, level: levelNum });
        
    } catch (e: any) {
        if (e.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: `Chapter ${chapterNum} data not found.` });
        }
        console.error('Error loading unit data:', e);
        return res.status(500).json({ error: 'Failed to load unit data.' });
    }
});

// Dialogue API (blocked during maintenance)
app.post('/api/getDialogue', maintenanceGuard, (req: Request, res: Response) => {
    // Get chapter, level, and type (pre/post) from request
    const chapterNum = Number(req.body.ch);
    const levelNum = Number(req.body.lvl) || 1;
    const dialogueType = req.body.type || 'pre'; // 'pre' or 'post'

    if (isNaN(chapterNum)) {
        return res.status(400).json({ error: 'Invalid chapter number (ch).' });
    }

    // --- File Loading Section ---
    let chapterData: ChapterDialogue;
    try {
        const filePath = path.join(__dirname, 'static', 'story', 'dialogue', `ch${chapterNum}.json`);
        chapterData = require(filePath); 
    } catch (e: any) {
        if (e.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: `Chapter file ch${chapterNum}.json not found.` });
        }
        console.error('Error loading or parsing chapter file:', e);
        return res.status(500).json({ error: 'Failed to load chapter data.' });
    }

    const chapterDialogues = chapterData.dialogue;

    // Level number maps to dialogue set index (level 1 = index 0, etc.)
    const dialogueIndex = levelNum - 1;
    const dialogueSet = chapterDialogues[dialogueIndex];
    
    if (!dialogueSet) {
        // Return empty dialogue if level doesn't have dialogue defined
        return res.json([{ speaker: "SYSTEM", text: "No dialogue for this level." }]);
    }

    let requestedDialogue: DialogueLine[] | undefined;

    // Determine pre or post combat dialogue
    if (dialogueType === 'pre') {
        requestedDialogue = dialogueSet[0];
    } else if (dialogueType === 'post') {
        if (dialogueSet.length > 1) {
            requestedDialogue = dialogueSet[1];
        } else {
            // No post-combat dialogue defined, return simple victory message
            return res.json([{ speaker: "SYSTEM", text: "Victory!" }]);
        }
    } else {
        return res.status(400).json({ error: 'Type must be "pre" or "post".' });
    }

    // 4. Send the result
    if (requestedDialogue) {
        return res.json({ dialogue: requestedDialogue });
    } else {
        // Should not be reached, but included for robustness
        return res.status(500).json({ error: 'An unexpected error occurred while processing dialogue data.' });
    }
});

// Level up a character for a user's chapter
app.post('/api/accounts/:username/level-up', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const { chapter, charIndex } = req.body;

        if (!chapter || (charIndex === undefined || charIndex === null)) {
            return res.status(400).json({ error: 'chapter and charIndex are required' });
        }

        const chapterKey = String(chapter);

        const account = await db.collection<Account>('accounts').findOne({ username });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        // Ensure chapter object exists
        if (!account.chapters) account.chapters = {} as any;
        if (!account.chapters[chapterKey]) {
            account.chapters[chapterKey] = {
                unlocked: true,
                completed: false,
                currentLevel: 1,
                levelsCompleted: 0,
                totalLevels: getChapterLevelCount(Number(chapterKey)),
                savedProgress: null,
                characterLevels: [1,1,1,1,1],
                inventory: { currency: 1000, pulls: 10, unlockedAbilities: [] }
            } as ChapterProgress;
        }

        const levels = account.chapters[chapterKey].characterLevels || [1,1,1,1,1];
        const idx = Number(charIndex);
        if (idx < 0 || idx >= levels.length) return res.status(400).json({ error: 'Invalid charIndex' });

        const currentCharLevel = (levels[idx] || 1);
        // Use leveling.json config for cost formula
        const cost = getLevelUpCost(currentCharLevel);

        // Ensure inventory exists
        if (!account.chapters[chapterKey].inventory) account.chapters[chapterKey].inventory = { currency: 0, pulls: 0, unlockedAbilities: [] } as any;
        const currentCurrency = account.chapters[chapterKey].inventory.currency || 0;

        if (currentCurrency < cost) {
            return res.status(402).json({ error: 'Insufficient currency', required: cost, current: currentCurrency });
        }

        // Deduct cost and increment level
        levels[idx] = currentCharLevel + 1;

        const updatePath = `chapters.${chapterKey}.characterLevels`;
        const currencyPath = `chapters.${chapterKey}.inventory.currency`;
        await db.collection<Account>('accounts').updateOne(
            { username },
            { $set: { [updatePath]: levels }, $inc: { [currencyPath]: -cost } }
        );

        return res.json({ message: 'Levelled up', characterLevels: levels, cost, remaining: currentCurrency - cost });
    } catch (e) {
        console.error('Level up error:', e);
        return res.status(500).json({ error: 'Failed to level up' });
    }
});

// ==================== GACHA API ROUTES ====================

// Gacha config cache
let gachaConfig: any = null;

function getGachaConfig() {
    if (gachaConfig) return gachaConfig;
    try {
        const fs = require('fs');
        const configPath = path.join(__dirname, 'static', 'gacha', 'config.json');
        if (fs.existsSync(configPath)) {
            gachaConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return gachaConfig;
        }
    } catch (e) {
        console.warn('Could not load gacha config:', e);
    }
    // Fallback defaults
    return {
        pullCost: 100,
        multiPullCount: 10,
        maxDuplicates: 5,
        rarityWeights: { common: 50, uncommon: 30, rare: 15, epic: 4, legendary: 1 },
        chapters: {}
    };
}

// Weighted random selection based on rarity
function selectAbilityByRarity(abilities: any[], rarityWeights: Record<string, number>): any {
    // Calculate total weight
    const totalWeight = Object.values(rarityWeights).reduce((a, b) => a + b, 0);
    
    // Roll for rarity
    let roll = Math.random() * totalWeight;
    let selectedRarity = 'common';
    
    for (const [rarity, weight] of Object.entries(rarityWeights)) {
        roll -= weight;
        if (roll <= 0) {
            selectedRarity = rarity;
            break;
        }
    }
    
    // Filter abilities by selected rarity
    const matchingAbilities = abilities.filter(a => a.rarity === selectedRarity);
    
    // If no abilities of that rarity, fall back to any ability
    if (matchingAbilities.length === 0) {
        return abilities[Math.floor(Math.random() * abilities.length)];
    }
    
    // Return random ability from matching rarity
    return matchingAbilities[Math.floor(Math.random() * matchingAbilities.length)];
}

// Get gacha info for a chapter
app.get('/api/gacha/:chapter', async (req: Request, res: Response) => {
    try {
        const chapterNum = parseInt(req.params.chapter || '1');
        const config = getGachaConfig();
        const chapterConfig = config.chapters[String(chapterNum)];
        
        if (!chapterConfig) {
            return res.status(404).json({ error: 'Chapter not found' });
        }
        
        if (!chapterConfig.hasGacha) {
            return res.status(400).json({ error: 'This chapter does not have a gacha system' });
        }
        
        return res.json({
            chapter: chapterNum,
            name: chapterConfig.name,
            pullCost: config.pullCost,
            multiPullCount: config.multiPullCount,
            maxDuplicates: config.maxDuplicates,
            rarityWeights: config.rarityWeights,
            abilities: chapterConfig.abilities
        });
    } catch (e) {
        console.error('Get gacha info error:', e);
        return res.status(500).json({ error: 'Failed to get gacha info' });
    }
});

// Perform gacha pull(s)
app.post('/api/gacha/:chapter/pull', maintenanceGuard, async (req: Request, res: Response) => {
    try {
        const { username, count } = req.body;
        const chapterNum = parseInt(req.params.chapter || '1');
        const pullCount = count === 10 ? 10 : 1; // Only allow 1 or 10 pulls
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }
        
        const config = getGachaConfig();
        const chapterConfig = config.chapters[String(chapterNum)];
        
        if (!chapterConfig || !chapterConfig.hasGacha) {
            return res.status(400).json({ error: 'This chapter does not have a gacha system' });
        }
        
        if (!chapterConfig.abilities || chapterConfig.abilities.length === 0) {
            return res.status(400).json({ error: 'No abilities available in this chapter gacha' });
        }
        
        const totalCost = config.pullCost * pullCount;
        const chapterKey = String(chapterNum);
        
        // Get account
        const account = await db.collection<Account>('accounts').findOne({ username });
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Check if chapter is unlocked and has inventory
        const chapterData = account.chapters?.[chapterKey];
        if (!chapterData) {
            return res.status(400).json({ error: 'Chapter not unlocked' });
        }
        
        const currentCurrency = chapterData.inventory?.currency || 0;
        if (currentCurrency < totalCost) {
            return res.status(400).json({ 
                error: 'Not enough currency', 
                required: totalCost, 
                current: currentCurrency 
            });
        }
        
        // Get current ability inventory (or initialize it)
        const abilityInventory: Record<string, number> = chapterData.inventory?.abilityInventory || {};
        
        // Perform pulls
        const results: { ability: any; isNew: boolean; isDuplicate: boolean; wasWasted: boolean }[] = [];
        
        for (let i = 0; i < pullCount; i++) {
            const ability = selectAbilityByRarity(chapterConfig.abilities, config.rarityWeights);
            const currentCount = abilityInventory[ability.name] || 0;
            
            const isNew = currentCount === 0;
            const wasWasted = currentCount >= config.maxDuplicates;
            const isDuplicate = currentCount > 0 && currentCount < config.maxDuplicates;
            
            // Add to inventory if not at max
            if (!wasWasted) {
                abilityInventory[ability.name] = currentCount + 1;
            }
            
            results.push({
                ability,
                isNew,
                isDuplicate,
                wasWasted
            });
        }
        
        // Update database
        const currencyPath = `chapters.${chapterKey}.inventory.currency`;
        const inventoryPath = `chapters.${chapterKey}.inventory.abilityInventory`;
        const unlockedPath = `chapters.${chapterKey}.inventory.unlockedAbilities`;
        
        // Build list of newly unlocked abilities for legacy support
        const newlyUnlocked = results
            .filter(r => r.isNew)
            .map(r => r.ability.name);
        
        const updateOps: any = {
            $inc: { [currencyPath]: -totalCost },
            $set: { [inventoryPath]: abilityInventory }
        };
        
        // Add newly unlocked to the legacy array
        if (newlyUnlocked.length > 0) {
            updateOps.$addToSet = { [unlockedPath]: { $each: newlyUnlocked } };
        }
        
        await db.collection<Account>('accounts').updateOne({ username }, updateOps);
        
        return res.json({
            success: true,
            results,
            cost: totalCost,
            remainingCurrency: currentCurrency - totalCost,
            abilityInventory,
            newAbilities: newlyUnlocked.length,
            wastedPulls: results.filter(r => r.wasWasted).length
        });
        
    } catch (e) {
        console.error('Gacha pull error:', e);
        return res.status(500).json({ error: 'Failed to perform gacha pull' });
    }
});

// Get user's ability inventory for a chapter
app.get('/api/gacha/:chapter/inventory/:username', async (req: Request, res: Response) => {
    try {
        const { chapter, username } = req.params;
        const chapterNum = parseInt(chapter || '1');
        const chapterKey = String(chapterNum);
        
        const account = await db.collection<Account>('accounts').findOne({ username });
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        const chapterData = account.chapters?.[chapterKey];
        if (!chapterData) {
            return res.status(400).json({ error: 'Chapter not unlocked' });
        }
        
        const config = getGachaConfig();
        
        return res.json({
            chapter: chapterNum,
            currency: chapterData.inventory?.currency || 0,
            abilityInventory: chapterData.inventory?.abilityInventory || {},
            unlockedAbilities: chapterData.inventory?.unlockedAbilities || [],
            maxDuplicates: config.maxDuplicates
        });
        
    } catch (e) {
        console.error('Get inventory error:', e);
        return res.status(500).json({ error: 'Failed to get inventory' });
    }
});

// ==================== COMBAT API ROUTES ====================

// Start a new combat session
app.post('/api/combat/start', maintenanceGuard, async (req: Request, res: Response) => {
    try {
        const { username, chapter, level } = req.body;
        
        if (!username || !chapter || !level) {
            return res.status(400).json({ error: 'Username, chapter, and level are required.' });
        }
        
        // Fetch unit data (reuse existing logic)
        const chapterNum = Number(chapter);
        const levelNum = Number(level);
        
        // Load character data
        const charsPath = path.join(__dirname, 'static', 'chars', `ch${chapterNum}.json`);
        const charsData = require(charsPath);
        
        // Load character abilities
        const charAbilitiesPath = path.join(__dirname, 'static', 'chars', 'abilities.json');
        const charAbilities = require(charAbilitiesPath);
        
        // Load enemy definitions for this chapter
        const enemiesPath = path.join(__dirname, 'static', 'enemies', `ch${chapterNum}.json`);
        const enemiesData = require(enemiesPath);
        
        // Load level configuration
        const levelConfigPath = path.join(__dirname, 'static', 'story', 'enemy', `ch${chapterNum}.json`);
        const levelConfig = require(levelConfigPath);
        
        // Load enemy abilities
        const enemyAbilitiesPath = path.join(__dirname, 'static', 'enemies', 'abilities.json');
        const enemyAbilities = require(enemyAbilitiesPath);
        
        // Get account data for character levels and unlocked abilities
        let accountCharacterLevels: number[] | null = null;
        let unlockedAbilities: string[] = [];
        try {
            const account = await db.collection<Account>('accounts').findOne({ username });
            if (account) {
                const chapterKey = String(chapterNum);
                const ch = account.chapters?.[chapterKey];
                if (ch && Array.isArray(ch.characterLevels)) {
                    accountCharacterLevels = ch.characterLevels.slice();
                }
                if (ch?.inventory?.unlockedAbilities && Array.isArray(ch.inventory.unlockedAbilities)) {
                    unlockedAbilities = ch.inventory.unlockedAbilities;
                }
            }
        } catch (e) {
            console.warn('Failed to load account for combat:', e);
        }
        
        // Build PC data with abilities
        const PCs: Record<string, any> = {};
        const charNames = Object.keys(charsData as Record<string, any>);
        
        for (const [name, data] of Object.entries(charsData as Record<string, any>)) {
            const abilityName = data.ability;
            const baseAbility = charAbilities[abilityName] || {};
            
            let damage = baseAbility.damage || 0;
            let heal = baseAbility.heal || 0;
            let minroll = baseAbility.minroll || 0;
            let rolls = baseAbility.rolls || 0;
            
            const charIndex = charNames.indexOf(name);
            let charLevel = 1;
            
            if (accountCharacterLevels && charIndex >= 0 && accountCharacterLevels[charIndex]) {
                charLevel = accountCharacterLevels[charIndex];
                const upgrades = charLevel - 1;
                for (let step = 1; step <= upgrades; step++) {
                    const tripletIndex = Math.floor((step - 1) / 3);
                    const pos = (step - 1) % 3;
                    if (pos === 0) {
                        rolls += tripletIndex === 0 ? 1 : 2;
                    } else if (pos === 1) {
                        damage += tripletIndex === 0 ? 2 : 4;
                    } else if (pos === 2) {
                        minroll += 1;
                    }
                }
            }
            
            const primaryAbility = {
                damage,
                heal,
                minroll,
                rolls,
                type: baseAbility.type || "Adaptive",
                effect: abilityName,
                name: abilityName
            };
            
            const abilities = [primaryAbility];
            
            // Add unlocked abilities
            for (const unlockedName of unlockedAbilities) {
                const unlockedData = charAbilities[unlockedName];
                if (unlockedData) {
                    let uaDamage = unlockedData.damage || 0;
                    let uaHeal = unlockedData.heal || 0;
                    let uaMinroll = unlockedData.minroll || 0;
                    let uaRolls = unlockedData.rolls || 0;
                    
                    if (accountCharacterLevels && charIndex >= 0) {
                        const level = accountCharacterLevels[charIndex] || 1;
                        const upgrades = level - 1;
                        for (let step = 1; step <= upgrades; step++) {
                            const tripletIndex = Math.floor((step - 1) / 3);
                            const pos = (step - 1) % 3;
                            if (pos === 0) uaRolls += tripletIndex === 0 ? 1 : 2;
                            else if (pos === 1) uaDamage += tripletIndex === 0 ? 2 : 4;
                            else if (pos === 2) uaMinroll += 1;
                        }
                    }
                    
                    abilities.push({
                        damage: uaDamage,
                        heal: uaHeal,
                        minroll: uaMinroll,
                        rolls: uaRolls,
                        type: unlockedData.type || "Adaptive",
                        effect: unlockedName,
                        name: unlockedName
                    });
                }
            }
            
            PCs[name] = {
                maxHp: data.maxHp,
                role: data.role,
                level: charLevel,
                ability: primaryAbility,
                abilities: abilities,
                passives: []
            };
        }
        
        // Find the level configuration
        const levelData = levelConfig.levels.find((l: any) => l.level === levelNum);
        if (!levelData) {
            return res.status(404).json({ error: `Level ${levelNum} not found in chapter ${chapterNum}.` });
        }
        
        // Get enemy scaling config
        const levelingCfg = getLevelingConfig();
        const enemyScaling = levelingCfg.enemyScaling || { enabled: false };
        const scalingEnabled = enemyScaling.enabled !== false;
        const startLevel = enemyScaling.startLevel || 2;
        const perLevel = enemyScaling.perLevel || { hp: 5, damage: 1, rolls: 0.5 };
        const scalingLevels = Math.max(0, levelNum - startLevel + 1);
        
        // Build enemy data
        const ENs: Record<string, any> = {};
        const enemyCount: Record<string, number> = {};
        
        for (const enemyName of levelData.enemies) {
            const enemyDef = enemiesData[enemyName];
            if (!enemyDef) continue;
            
            enemyCount[enemyName] = (enemyCount[enemyName] || 0) + 1;
            const uniqueKey = `EN${Object.keys(ENs).length}`;
            
            const abilityNames = enemyDef.abilities || (enemyDef.ability ? [enemyDef.ability] : []);
            const abilities = abilityNames.map((aName: string, idx: number) => {
                const abilityData = enemyAbilities[aName] || {};
                let damage = abilityData.damage || 0;
                let minroll = abilityData.minroll || 0;
                let rolls = abilityData.rolls || 0;
                
                if (scalingEnabled && scalingLevels > 0) {
                    damage += Math.floor(scalingLevels * (perLevel.damage || 0));
                    rolls += Math.floor(scalingLevels * (perLevel.rolls || 0));
                }
                
                return {
                    name: aName,
                    damage,
                    heal: 0,
                    minroll,
                    rolls,
                    type: abilityData.type || "Rolling"
                };
            });
            
            let maxHp = enemyDef.maxHp || 10;
            if (scalingEnabled && scalingLevels > 0) {
                maxHp += Math.floor(scalingLevels * (perLevel.hp || 0));
            }
            
            ENs[uniqueKey] = {
                maxHp,
                name: enemyDef.name,
                level: scalingEnabled ? Math.max(1, levelNum) : 1,
                ability: abilities[0] || { damage: 0, heal: 0, minroll: 0, rolls: 0, type: "Rolling" },
                abilities: abilities,
                passives: Object.keys(enemyDef.passives || {})
            };
        }
        
        // Create combat session
        const session = await createSession(username, chapterNum, levelNum, PCs, ENs);
        
        return res.json({
            message: 'Combat session started.',
            sessionId: session.sessionId,
            // Include WebSocket connection info
            wsUrl: `/ws/combat?sessionId=${session.sessionId}&username=${encodeURIComponent(username)}`,
            state: {
                units: session.units,
                phase: session.phase,
                turn: session.turn,
                turnOrder: session.turnOrder,
                enemyActions: session.enemyActions
            }
        });
        
    } catch (e: any) {
        console.error('Combat start error:', e);
        if (e.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: 'Chapter data not found.' });
        }
        return res.status(500).json({ error: 'Failed to start combat session.' });
    }
});

// Get combat session state
app.get('/api/combat/:sessionId', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const session = await getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Combat session not found.' });
        }
        
        const engine = new CombatEngine(session);
        return res.json({
            state: engine.getState()
        });
        
    } catch (e) {
        console.error('Get combat state error:', e);
        return res.status(500).json({ error: 'Failed to get combat state.' });
    }
});

// Submit player actions and execute turn
app.post('/api/combat/:sessionId/turn', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const { actions } = req.body;
        
        if (!actions || typeof actions !== 'object') {
            return res.status(400).json({ error: 'Actions object is required.' });
        }
        
        const session = await getSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Combat session not found.' });
        }
        
        if (session.phase !== 'PLANNING') {
            return res.status(400).json({ error: 'Combat is not in planning phase.' });
        }
        
        // Convert actions to proper format
        const playerActions: Record<string, CombatAction> = {};
        for (const [pcId, action] of Object.entries(actions)) {
            if (action && typeof action === 'object') {
                const a = action as any;
                playerActions[pcId] = {
                    sourceId: pcId,
                    sourceAbilityIndex: a.sourceAbilityIndex || 0,
                    targetId: a.targetId,
                    targetAbilityIndex: a.targetAbilityIndex || 0
                };
            }
        }
        
        // Execute turn
        const result = await executeCombatTurn(sessionId, playerActions);
        
        if (!result) {
            return res.status(500).json({ error: 'Failed to execute combat turn.' });
        }
        
        return res.json({
            events: result.events,
            state: result.state
        });
        
    } catch (e) {
        console.error('Combat turn error:', e);
        return res.status(500).json({ error: 'Failed to execute combat turn.' });
    }
});

// Update enemy plan based on player targeting (reactive planning)
app.post('/api/combat/:sessionId/updateEnemyPlans', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const { pendingActions } = req.body;
        
        const session = await getSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Combat session not found.' });
        }
        
        // Use the centralized updateEnemyPlans function
        const newEnemyActions = await updateEnemyPlans(sessionId, pendingActions);
        
        if (!newEnemyActions) {
            return res.status(500).json({ error: 'Failed to update enemy plans.' });
        }
        
        return res.json({
            enemyActions: newEnemyActions
        });
        
    } catch (e) {
        console.error('Update enemy plans error:', e);
        return res.status(500).json({ error: 'Failed to update enemy plans.' });
    }
});

// End combat session (cleanup)
app.delete('/api/combat/:sessionId', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const deleted = await deleteSession(sessionId);
        
        if (!deleted) {
            return res.status(404).json({ error: 'Combat session not found.' });
        }
        
        return res.json({ message: 'Combat session ended.' });
        
    } catch (e) {
        console.error('End combat error:', e);
        return res.status(500).json({ error: 'Failed to end combat session.' });
    }
});

// Check for existing active session (reconnection support)
app.get('/api/combat/check/:username', async (req: Request, res: Response) => {
    try {
        const { username } = req.params;
        const session = await getSessionByUsername(username);
        
        if (!session || session.phase === 'VICTORY' || session.phase === 'DEFEAT') {
            return res.json({ hasActiveSession: false });
        }
        
        const engine = new CombatEngine(session);
        return res.json({
            hasActiveSession: true,
            sessionId: session.sessionId,
            wsUrl: `/ws/combat?sessionId=${session.sessionId}&username=${encodeURIComponent(username)}`,
            state: engine.getState()
        });
        
    } catch (e) {
        console.error('Check session error:', e);
        return res.status(500).json({ error: 'Failed to check for active session.' });
    }
});

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
});

// Create HTTP server for Express and WebSocket
const server = createServer(app);

// WebSocket manager (initialized after server starts)
let wsManager: CombatWebSocketManager | null = null;

// Setup WebSocket handlers
function setupWebSocketHandlers(manager: CombatWebSocketManager) {
    // Handle player actions via WebSocket
    manager.onPlayerAction = async (sessionId: string, action: any) => {
        const session = await getSession(sessionId);
        if (!session) {
            manager.sendToSession(sessionId, {
                type: 'error',
                payload: { error: 'Session not found' }
            });
            return;
        }
        
        switch (action.type) {
            case 'execute_turn':
                // Execute the combat turn
                const playerActions: Record<string, CombatAction> = {};
                for (const [pcId, a] of Object.entries(action.actions || {})) {
                    if (a && typeof a === 'object') {
                        const actionData = a as any;
                        playerActions[pcId] = {
                            sourceId: pcId,
                            sourceAbilityIndex: actionData.sourceAbilityIndex || 0,
                            targetId: actionData.targetId,
                            targetAbilityIndex: actionData.targetAbilityIndex || 0
                        };
                    }
                }
                
                const result = await executeCombatTurn(sessionId, playerActions);
                if (result) {
                    // Send events and state to client
                    manager.sendToSession(sessionId, {
                        type: 'turn_result',
                        payload: {
                            events: result.events,
                            state: result.state
                        }
                    });
                } else {
                    manager.sendToSession(sessionId, {
                        type: 'error',
                        payload: { error: 'Failed to execute turn' }
                    });
                }
                break;
                
            case 'update_pending':
                // Player is updating their pending action (for enemy reactive planning)
                const pendingActions = action.pendingActions || {};
                const newEnemyActions = await updateEnemyPlans(sessionId, pendingActions);
                
                if (newEnemyActions) {
                    manager.sendToSession(sessionId, {
                        type: 'enemy_plans_updated',
                        payload: { enemyActions: newEnemyActions }
                    });
                }
                break;
                
            case 'end_combat':
                // End the combat session
                await deleteSession(sessionId);
                manager.sendToSession(sessionId, {
                    type: 'combat_ended',
                    payload: { message: 'Combat session ended' }
                });
                break;
        }
    };
    
    // Handle player reconnection
    manager.onPlayerReconnect = async (sessionId: string, username: string) => {
        // First try to get session by ID
        let session = await getSession(sessionId);
        
        // If not found by ID, try to find by username
        if (!session) {
            session = await getSessionByUsername(username);
        }
        
        if (!session) {
            return null;
        }
        
        // Mark as connected
        await markSessionConnected(session.sessionId);
        
        // Return current state
        const engine = new CombatEngine(session);
        return {
            sessionId: session.sessionId,
            state: engine.getState(),
            restored: true
        };
    };
    
    // Handle player disconnect
    manager.onPlayerDisconnect = async (sessionId: string, _username: string) => {
        // Just mark as disconnected - session persists in MongoDB
        await markSessionDisconnected(sessionId);
    };
}

server.listen(PORT, async () => {
    await connectToMongo();
    
    // Initialize combat session database
    initCombatSessionDB(db);
    
    // Initialize WebSocket manager
    wsManager = new CombatWebSocketManager(server);
    setupWebSocketHandlers(wsManager);
    
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws/combat`);
});