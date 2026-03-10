const axios = require('axios');

const API_URL = "http://localhost:3000/incidents";

const errorTemplates = [
    "DB Connection Timeout on Node 4",
    "PostgreSQL: Too many clients already",
    "Connection reset by peer in DB-Pool",
    "Service Mesh: Failure to reach Database-Cluster",
    "High Latency on SQL Query Execution"
];

async function generateSpike() {
    console.log("🚀 Starting Spike Simulation...");
    
    for (let i = 0; i < 10; i++) {
        const title = errorTemplates[i % errorTemplates.length];
        try {
            await axios.post(API_URL, {
                title: title,
                description: `Automated error report iteration ${i}. System pressure high.`,
                environment: "Prod"
            });
            console.log(`[+] Injected: ${title}`);
        } catch (err) {
            console.error("[-] Failed to inject incident");
        }
    }
    console.log("✅ Spike seeded. 10 incidents added.");
}

generateSpike();