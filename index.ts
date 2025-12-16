import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { MongoClient, Db, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

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
        unlockedAbilities: string[];
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

//this is temporary until we set up proper routing
//app.use(express.static(path.join(process.cwd(), 'public')));

// Simple health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
        
        // Update last login
        await db.collection<Account>('accounts').updateOne(
            { _id: account._id },
            { $set: { lastLogin: new Date() } }
        );
        
        // Return account data (excluding password hash)
        const { passwordHash, ...safeAccount } = account;
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
        const account = await db.collection<Account>('accounts').findOne({ username });
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found.' });
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
        
        const updateObj: any = {};
        
        // If completing a new level (not replaying)
        if (levelNum === currentLevel) {
            updateObj[`chapters.${chapterKey}.levelsCompleted`] = levelNum;
            
            // If there are more levels, unlock the next one
            if (levelNum < totalLevels) {
                updateObj[`chapters.${chapterKey}.currentLevel`] = levelNum + 1;
            } else {
                // Chapter completed!
                updateObj[`chapters.${chapterKey}.completed`] = true;
                
                // Unlock next chapter
                const nextChapterKey = String(chapterNum + 1);
                updateObj[`chapters.${nextChapterKey}`] = {
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
        
        // Update stats
        updateObj['stats.totalBattles'] = (account.stats?.totalBattles || 0) + 1;
        updateObj['stats.wins'] = (account.stats?.wins || 0) + 1;
        
        await db.collection<Account>('accounts').updateOne(
            { username },
            { $set: updateObj }
        );
        
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

// Helper function to get the number of levels per chapter
function getChapterLevelCount(chapter: number): number {
    const levelCounts: Record<number, number> = {
        1: 10,
        2: 12,
        3: 10,
        4: 8,
        5: 10,
        6: 12,
        7: 10,
        8: 15,
        9: 10,
        10: 20
    };
    return levelCounts[chapter] || 10;
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

// ==================== END ACCOUNT API ROUTES ====================

// Page routes
app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/chapters', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'chapters.html'));
});

app.get('/levels', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'levels.html'));
});

app.get('/combat', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'combat.html'));
});

app.get('/combat.js', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'combat.js'));
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

// API to get character data for a chapter and level
app.get('/api/getUnits', (req: Request, res: Response) => {
    const chapterNum = Number(req.query.ch) || 1;
    const levelNum = Number(req.query.lvl) || 1;
    
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
        
        // Build PC data with resolved abilities
        const PCs: Record<string, any> = {};
        for (const [name, data] of Object.entries(charsData as Record<string, any>)) {
            const abilityName = data.ability;
            const abilityData = charAbilities[abilityName] || {};
            PCs[name] = {
                maxHp: data.maxHp,
                role: data.role,
                ability: {
                    damage: abilityData.damage || 0,
                    heal: abilityData.heal || 0,
                    minroll: abilityData.minroll || 0,
                    rolls: abilityData.rolls || 0,
                    type: abilityData.type || "Adaptive",
                    effect: abilityName
                }
            };
        }
        
        // Find the level configuration
        const levelData = levelConfig.levels.find((l: any) => l.level === levelNum);
        if (!levelData) {
            return res.status(404).json({ error: `Level ${levelNum} not found in chapter ${chapterNum}.` });
        }
        
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
                return {
                    name: abilityName,
                    damage: abilityData.damage || 0,
                    minroll: abilityData.minroll || 0,
                    rolls: abilityData.rolls || 0,
                    type: abilityData.type || "Rolling"
                };
            });
            
            const passiveNames = Object.keys(enemyDef.passives || {});
            
            ENs[uniqueKey] = {
                maxHp: enemyDef.maxHp,
                name: enemyDef.name,
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

app.post('/api/getDialogue', (req: Request, res: Response) => {
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

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
});

app.listen(PORT, async () => {
    await connectToMongo();
    console.log(`Server listening on http://localhost:${PORT}`);
});