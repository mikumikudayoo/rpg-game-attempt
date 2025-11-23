import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Simple health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Example route
app.get('/', (_req: Request, res: Response) => {
    res.send('Hello from Express + TypeScript');
});

const Script = [
    { speaker: "???", text: "man, that guy just killed my entire team... well time to restart..." },
    { speaker: "You", text: "yo, who r u??" },
    { speaker: "???", text: "yo, im just the manager for this team. im just struggling because of these enemies :(" },
    { speaker: "You", text: "yeah i can tell, but like whats ur name and stuff" },
    { speaker: "D.Y.L.A.N", text: "oh right mb, im D.Y.L.A.N" },
    { speaker: "You", text: "oh so ur a clanker?" },
    { speaker: "D.Y.L.A.N", text: "yeah, i just wanna get through these enemies and secure this sector, u mind being the manager now??" },
    { speaker: "You", text: "aight bet" },
    { speaker: "D.Y.L.A.N", text: "dude ur such a life saver, ur literally a gift from..." },
    { speaker: "You", text: "from what...? god?" },
    { speaker: "D.Y.L.A.N", text: "yeah, from our lord and savior hatsune miku.." },
    { speaker: "You", text: "what." },
    { speaker: "D.Y.L.A.N", text: "anyways lets get going, these enemies wont take themselves out!" },
    { speaker: "You", text: "dude i dont even know how to play this game..." },
    { speaker: "D.Y.L.A.N", text: "oh right im the tutorial guy i completely forgot" },
    { speaker: "D.Y.L.A.N", text: "basically just drag and drop. you will see an arrow from your character to the enemy you want to attack." },
    { speaker: "D.Y.L.A.N", text: "if the character you selected is a healer, then instead of an enemy, you must select a teammate to heal." },
    { speaker: "D.Y.L.A.N", text: "there is no need to use all of your characters, but be mindful! they can still be attacked by enemies." },
    { speaker: "D.Y.L.A.N", text: "when you are done selecting, just press the big giant button you see." },
    { speaker: "You", text: "aight i think i can deal with that" },
];


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