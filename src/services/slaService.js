// src/services/slaService.js

const calculateSlaDeadline = (severity) => {
    const now = new Date();
    const sev = parseInt(severity);

    switch (sev) {
        case 1: return new Date(now.getTime() + 1 * 60 * 60 * 1000);    // 1 hour
        case 2: return new Date(now.getTime() + 4 * 60 * 60 * 1000);    // 4 hours
        case 3: return new Date(now.getTime() + 24 * 60 * 60 * 1000);   // 24 hours
        default: return new Date(now.getTime() + 24 * 60 * 60 * 1000); // Default 24h
    }
};

module.exports = { calculateSlaDeadline };