import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';

// Define the expected structure for clarity
interface DialogueLine {
    speaker: string;
    text: string;
}
type DialoguePair = [DialogueLine[]] | [DialogueLine[], DialogueLine[]];
interface ChapterDialogue {
    dialogue: DialoguePair[];
}

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Middleware
app.use(express.json());

//this is temporary until we set up proper routing
//app.use(express.static(path.join(process.cwd(), 'public')));

// Simple health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Example route
app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/combat', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'combat.html'));
});

app.post('/api/getDialogue', (req: Request, res: Response) => {
    // 1. Get and validate query parameters
    const chapterNum = Number(req.body.ch);
    const index1 = Number(req.body.i1); // Dialogue set index (e.g., 0, 1, 2...)
    // Convert 'null' string or undefined to null, otherwise convert to number
    const index2 = req.body.i2 !== 'null' && req.body.i2 !== undefined ? Number(req.body.i2) : null; 

    if (isNaN(chapterNum) || isNaN(index1)) {
        return res.status(400).json({ error: 'Invalid chapter number (ch) or dialogue set index (i1).' });
    }

    // --- File Loading Section ---
    let chapterData: ChapterDialogue;
    try {
        // Construct the absolute path to the JSON file. 
        // Assumes your Express server root is the base for /static.
        const filePath = path.join(__dirname, 'static', 'story', 'dialogue', `ch${chapterNum}.json`);
        
        // Load the JSON file synchronously
        chapterData = require(filePath); 

    } catch (e: any) {
        // Handle file not found (likely chapter not existing) or JSON parsing errors
        if (e.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: `Chapter file ch${chapterNum}.json not found in /static/story/.` });
        }
        console.error('Error loading or parsing chapter file:', e);
        return res.status(500).json({ error: 'Failed to load chapter data due to an internal server error.' });
    }
    // --- End File Loading Section ---

    const chapterDialogues = chapterData.dialogue;

    // 2. Navigate to the dialogue set using index1
    const dialogueSet = chapterDialogues[index1];
    if (!dialogueSet) {
        return res.status(404).json({ error: `Dialogue set index i1=${index1} not found in chapter ${chapterNum}.` });
    }

    let requestedDialogue: DialogueLine[] | undefined;

    // 3. Determine the specific dialogue array using index2
    if (index2 === 0 || index2 === null) {
        // i2=0 (Pre-Combat) or i2=null (Defaulting to Pre-Combat)
        requestedDialogue = dialogueSet[0];
    } else if (index2 === 1) {
        // i2=1 (Post-Combat)
        if (dialogueSet.length > 1) {
            requestedDialogue = dialogueSet[1];
        } else {
            return res.status(404).json({ error: `Post-combat dialogue (i2=1) not found for dialogue set i1=${index1}.` });
        }
    } else {
        return res.status(400).json({ error: 'Index i2 must be 0 (pre-combat), 1 (post-combat), or null.' });
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

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});