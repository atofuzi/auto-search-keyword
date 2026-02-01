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
app.use('/download', express.static(process.cwd()));

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

    socket.on('start', async (data: { keyword: string, customWords: string }) => {
        console.log('Start command received', data);
        const { keyword, customWords } = data;
        const customWordsList = customWords ? customWords.split(/[\s|　]+/).filter(s => s.length > 0) : [];

        await scraperService.start(keyword, customWordsList, socket);
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
