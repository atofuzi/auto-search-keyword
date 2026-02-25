import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { ScraperService } from './scraperService';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (CSV downloads) from root
// Serve static files (CSV downloads) from root
app.use('/download', express.static(process.cwd(), {
    setHeaders: (res, path, stat) => {
        res.set('Content-Disposition', 'attachment');
    }
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all for dev
        methods: ["GET", "POST"]
    }
});

const scraperService = new ScraperService();

io.on('connection', (socket) => {
    console.log('Client connected');

    // Phase 1: Get Suggestions
    socket.on('getSuggestions', async (data: { keyword: string, verificationMode?: boolean }) => {
        console.log('Suggestions requested', data);
        const { keyword, verificationMode = false } = data;

        const envVerification = process.env.VERIFICATION_MODE === 'true';
        const isVerify = verificationMode || envVerification;

        await scraperService.getSuggestionsOnly(keyword, socket, isVerify);
    });

    // Phase 2: Start Analysis
    socket.on('startAnalysis', async (data: {
        keywords: string[],
        threshold?: number,
        customWords?: string,
        baseKeyword?: string,
        useCache?: boolean
    }) => {
        console.log('Analysis requested', data.keywords.length + ' keywords');
        const { keywords, threshold = 3, customWords = '', baseKeyword = '', useCache = true } = data;

        const customWordsArray = customWords
            ? customWords.split(/[\s|　]+/).filter(w => w.length > 0)
            : [];

        await scraperService.analyzeKeywords(keywords, socket, threshold, customWordsArray, baseKeyword, useCache);
    });

    socket.on('stop', async () => {
        console.log('Stop command received');
        await scraperService.stop();
        socket.emit('log', 'Process stopped by user.');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        scraperService.stop();
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
