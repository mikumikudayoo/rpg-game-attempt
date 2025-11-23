import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Middleware
app.use(express.json());

// Simple health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Example route
app.get('/', (_req: Request, res: Response) => {
    res.send('Hello from Express + TypeScript');
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