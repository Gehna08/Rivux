const axios = require("axios");
const pool = require("../config/db");

// ✅ Helper: Internal SLA calculation
const calculateSlaDeadline = (severity) => {
    const now = new Date();
    const sev = parseInt(severity) || 3;
    switch (sev) {
        case 1: return new Date(now.getTime() + 1 * 60 * 60 * 1000);    // 1h
        case 2: return new Date(now.getTime() + 4 * 60 * 60 * 1000);    // 4h
        case 3: return new Date(now.getTime() + 24 * 60 * 60 * 1000);   // 24h
        default: return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
};

// ✅ Create Incident with Smart Deduplication
const createIncident = async (req, res) => {
    const { title, description, environment = "Prod", project_id } = req.body;
    const userId = req.user ? req.user.id : null; 

    // 1. Validation
    if (!project_id) return res.status(400).json({ error: "project_id is required" });

    try {
        let severity = 3; 
        let embedding = null;
        let aiStatus = "success";
        let parentIncidentId = null;
        let confidenceScore = null;

        // 2. Attempt AI Analysis (Severity & Embedding)
        try {
            console.log("--- Calling AI Service ---");
            const aiResponse = await axios.post("http://127.0.0.1:8000/analyze", {
                text: `${title} ${description}`
            }, { timeout: 2000 });

            severity = parseInt(aiResponse.data.severity) || 3;
            embedding = aiResponse.data.embedding;
        } catch (aiErr) {
            console.error("⚠️ AI Service offline. Falling back to local defaults.");
            aiStatus = "fallback";
        }

        // 3. 🧠 Smart Deduplication Check
        // Updated threshold to 0.18 based on testing (Distance was 0.14)
        if (embedding) {
            console.log("--- Checking for duplicate incidents ---");
            const potentialDup = await pool.query(
                `SELECT id, title, (embedding <=> $1) as distance 
                 FROM incidents 
                 WHERE status != 'Resolved' 
                   AND created_at > NOW() - INTERVAL '6 hours'
                   AND (embedding <=> $1) < 0.18
                 ORDER BY distance ASC LIMIT 1`,
                [JSON.stringify(embedding)]
            );

            if (potentialDup.rows.length > 0) {
                parentIncidentId = potentialDup.rows[0].id;
                // Convert distance to a human-readable confidence percentage
                confidenceScore = (1 - potentialDup.rows[0].distance).toFixed(2);
                console.log(`🔍 Duplicate Detected: Linked to #${parentIncidentId} (${confidenceScore * 100}% match)`);
            }
        }

        // 4. Calculate SLA
        const slaDeadline = calculateSlaDeadline(severity);

        // 5. Database Insert
        console.log(`--- Inserting to DB (Project: ${project_id}, User: ${userId}) ---`);
        const result = await pool.query(
            `INSERT INTO incidents (
                title, description, severity, status, sla_deadline, 
                embedding, environment, project_id, created_by, parent_incident_id
             )
             VALUES ($1, $2, $3, 'Open', $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                title, 
                description, 
                severity, 
                slaDeadline, 
                JSON.stringify(embedding), 
                environment, 
                project_id, 
                userId, 
                parentIncidentId
            ]
        );

        const newIncident = result.rows[0];

        // 6. Return response with AI Insights & Confidence Score
        res.status(201).json({
            incident: newIncident,
            ai_metadata: {
                ai_status: aiStatus,
                is_duplicate: !!parentIncidentId,
                suggested_parent: parentIncidentId,
                similarity_confidence: confidenceScore ? `${Math.round(confidenceScore * 100)}%` : null
            }
        });

    } catch (err) {
        console.error("❌ Database Error:", err.message);
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get All Incidents (Enhanced with Join for Creator Name)
const getAllIncidents = async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT i.*, u.name as creator_name 
        FROM incidents i 
        LEFT JOIN users u ON i.created_by = u.id 
        ORDER BY i.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching incidents" });
  }
};

// ✅ Get Single Incident
const getIncidentById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
        SELECT i.*, u.name as creator_name 
        FROM incidents i 
        LEFT JOIN users u ON i.created_by = u.id 
        WHERE i.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching incident" });
  }
};

// ✅ Assign Incident
const assignIncident = async (req, res) => {
  try {
    const { incidentId, assignedTo } = req.body;
    const result = await pool.query(
      `UPDATE incidents
       SET assigned_to = $1, status = 'Assigned'
       WHERE id = $2
       RETURNING *`,
      [assignedTo, incidentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }
    res.json({ message: "Incident assigned successfully", incident: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while assigning incident" });
  }
};

// ✅ Delete Incident
const deleteIncident = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM incidents WHERE id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }
    res.json({ message: "Incident deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting incident" });
  }
};

module.exports = {
  createIncident,
  getAllIncidents,
  getIncidentById,
  assignIncident,
  deleteIncident,
};