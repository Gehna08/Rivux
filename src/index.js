//uvicorn main:app --reload --host 0.0.0.0 --port 8000
// Load environment variables from a .env file
require("dotenv").config();

//DOUBT 1
const { getCurrentResponder } = require("./services/onCallService");

// Import Express to create the server
const express = require("express");
// Initialize Express app
const app = express();
// Import CORS middleware to handle cross-origin requests
const cors = require("cors");
// Enable CORS for all routes
app.use(cors());

// Import database connection pool (PostgreSQL)
const pool = require("./config/db");

const axios = require("axios");
const { protect } = require("./middleware/authMiddleware");
const { runEscalationCheck } = require("./services/escalationService");

// Enable parsing of JSON request bodies
app.use(express.json());
const redisClient = require("./config/redis");
const cacheMiddleware = require("./middleware/cacheMiddleware");

const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authRoutes);
const incidentRoutes = require("./routes/incidentRoutes");
app.use("/api/incidents", incidentRoutes);

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

// Function to check if a status transition is allowed for an incident
// Example: Open → Investigating
// We validate it based on workflow rules stored in the database
const validateTransition = async (incidentId, newStatus, userRole) => {
  // Query the database to get:
  // 1️⃣ Current status of the incident
  // 2️⃣ Workflow assigned to the project this incident belongs to
  const incidentQuery = await pool.query(
    `SELECT i.status, p.workflow_id 
     FROM incidents i
     JOIN projects p ON i.project_id = p.id
     WHERE i.id = $1`,
    [incidentId] // incidentId is passed as a parameter to prevent SQL injection
  );

  // If no incident was found with this ID, return false
  // Meaning the transition cannot be validated
  if (incidentQuery.rowCount === 0) return false;

  // Extract the current status and workflow_id from the query result
  // Example: status = "Open", workflow_id = 1
  const { status: currentStatus, workflow_id } = incidentQuery.rows[0];

  // Now check if a transition rule exists in the workflow_transitions table
  // that allows moving from the current status → new status
  const transition = await pool.query(
    `SELECT * FROM workflow_transitions
     WHERE workflow_id = $1
     AND from_status = $2
     AND to_status = $3`,
    [workflow_id, currentStatus, newStatus]
  );

  // If no rule exists for this transition, it means it is NOT allowed
  // Example: Trying Open → Resolved directly
  if (transition.rowCount === 0) return false;

  // Get the roles allowed to perform this transition
  // Example: ["engineer", "admin"]
  const allowedRoles = transition.rows[0].allowed_roles;

  // Check if the current user's role is in the allowed roles list
  // If yes → return true (transition allowed)
  // If no → return false (transition denieds
  return allowedRoles.includes(userRole);
};

// Function to calculate incident severity based on title/description
function calculateSeverity(title, description) {
    const text = (title + " " + description).toLowerCase();
    if (text.includes("down") || text.includes("crash") || text.includes("outage")) return 1; // P1
    if (text.includes("slow") || text.includes("delay") || text.includes("latency")) return 2; // P2
    return 3; // Default P3
}

// Function to check if SLA is breached or on time
function checkSla(incident) {
    const now = new Date();
    return now > incident.sla_deadline ? "Breached" : "OnTime";
}

// Function to log activities for incidents
async function logActivity(incidentId, action, oldValue, newValue, performedBy = "system") {
    await pool.query(
      `INSERT INTO incident_activity (incident_id, action_type, old_value, new_value, performed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [incidentId, action, JSON.stringify(oldValue), JSON.stringify(newValue), performedBy]
    );
}

async function detectPatterns() {
    const client = await pool.connect();
    try {
        // Query 1: Cluster Detection (Semantic Similarity)
        // We look for incidents within 0.15 distance of each other in the last 6 hours
        const clusters = await client.query(`
            SELECT 
                root.title AS pattern_lead,
                COUNT(others.id) + 1 AS cluster_size,
                ARRAY_AGG(others.id) AS related_incident_ids
            FROM incidents root
            JOIN incidents others ON (root.embedding <=> others.embedding) < 0.15
            WHERE root.created_at > NOW() - INTERVAL '6 hours'
              AND others.id != root.id
            GROUP BY root.id
            HAVING COUNT(others.id) >= 2
            ORDER BY cluster_size DESC;
        `);

        // Query 2: Service Spikes (Volume Anomaly)
        // Comparison: Last 1 hour vs average of previous 24 hours
        const spikes = await client.query(`
            SELECT service_name, current_count, avg_count
            FROM (
                SELECT 
                    service_name,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as current_count,
                    (COUNT(*) / 24.0) as avg_count
                FROM incidents
                WHERE created_at > NOW() - INTERVAL '24 hours'
                GROUP BY service_name
            ) stats
            WHERE current_count > (avg_count * 2) AND current_count > 5;
        `);

        return { clusters: clusters.rows, spikes: spikes.rows };
    } finally {
        client.release();
    }
}

// Function to find similar incidents using Vector Similarity
async function findSimilarIncidents(embedding, currentId, title) {
  try {
    const threshold = 0.25;

    // Extract keywords from title (simple but effective)
    const keywords = title.toLowerCase().split(" ");

    const result = await pool.query(
      `SELECT 
          id, 
          title, 
          description, 
          status,
          project_id,
          (embedding <=> $1) as distance
       FROM incidents 
       WHERE id != $2 
         AND embedding IS NOT NULL
         
         -- ✅ SAME PROJECT (VERY IMPORTANT)
         AND project_id = (
           SELECT project_id FROM incidents WHERE id = $2
         )

         -- ✅ EMBEDDING FILTER
         AND (embedding <=> $1) < $3

         -- ✅ KEYWORD FILTER (at least 1 match)
         AND (
           ${keywords.map((_, i) => `title ILIKE $${i + 4}`).join(" OR ")}
         )

       ORDER BY distance ASC 
       LIMIT 3`,
      [
        JSON.stringify(embedding),
        currentId,
        threshold,
        ...keywords.map(k => `%${k}%`)
      ]
    );

    // ✅ Add similarity confidence
    return result.rows.map(row => ({
      ...row,
      similarity_level:
        row.distance < 0.2 ? "High" :
        row.distance < 0.25 ? "Medium" : "Low"
    }));

  } catch (err) {
    console.error("Error finding similar incidents:", err.message);
    return [];
  }
}

// Root endpoint to check if server is running
app.get("/", (req, res) => {
  res.send("Incident Intelligence API running 🚀");
});

// Endpoint to get incident statistics
app.get("/incidents/stats", cacheMiddleware(60), async (req, res) => {
  try {
    // Total incidents
    const totalResult = await pool.query("SELECT COUNT(*) FROM incidents");

    // Count by status
    const statusResult = await pool.query(
      "SELECT status, COUNT(*) FROM incidents GROUP BY status"
    );

    // Count by severity
    const severityResult = await pool.query(
      "SELECT severity, COUNT(*) FROM incidents GROUP BY severity"
    );

    res.json({
      total: totalResult.rows[0].count,
      byStatus: statusResult.rows,
      bySeverity: severityResult.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching stats");
  }
});

// Endpoint to get a single incident by ID
app.get("/incidents/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT i.*, p.name as project_name, u.name as creator_name
       FROM incidents i
       JOIN projects p ON i.project_id = p.id
       LEFT JOIN users u ON i.created_by = u.id
       WHERE i.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching incident");
  }
});

// Endpoint to list incidents with filters, search, sorting, pagination
app.get("/incidents", async (req, res) => {
    try {
      let { status, severity, assigned_to, environment, search, sortBy, sortOrder, page, limit } = req.query;

      page = parseInt(page) || 1;           // Current page
      limit = parseInt(limit) || 20;        // Items per page
      const offset = (page - 1) * limit;    // Pagination offset

      let values = [];
      let query = "SELECT i.*, p.name as project_name FROM incidents i JOIN projects p ON i.project_id = p.id WHERE 1=1";

      // 🔹 Filters
      if (status) { values.push(status); query += ` AND status = $${values.length}`; }
      if (severity) { values.push(severity); query += ` AND severity = $${values.length}`; }
      if (assigned_to) { values.push(assigned_to); query += ` AND assigned_to = $${values.length}`; }
      if (environment) { values.push(environment); query += ` AND environment = $${values.length}`; }

      // 🔹 Search
      if (search) {
        values.push(`%${search}%`);
        query += ` AND (title ILIKE $${values.length} OR description ILIKE $${values.length})`;
      }

      // 🔹 Sorting
      sortBy = sortBy || "created_at";
      sortOrder = sortOrder === "asc" ? "ASC" : "DESC";
      query += ` ORDER BY ${sortBy} ${sortOrder}`;

      // 🔹 Pagination
      query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
      values.push(limit, offset);

      const result = await pool.query(query, values);

      res.json({
        page,
        limit,
        count: result.rows.length,
        incidents: result.rows
      });

    } catch (err) {
      console.error(err);
      res.status(500).send(err.message || "Error fetching incidents");
    }
});

// Endpoint to get all comments for an incident
app.get("/incidents/:id/comments", async (req, res) => {
    try {
      const { id } = req.params;

      const commentsResult = await pool.query(
        "SELECT * FROM incident_comments WHERE incident_id = $1 ORDER BY created_at ASC",
        [id]
      );

      res.json(commentsResult.rows);

    } catch (err) {
      console.error(err);
      res.status(500).send(err.message || "Error fetching comments");
    }
});

// Endpoint to detect patterns and anomalies
app.get("/analytics/patterns", async (req, res) => {
    try {
        const timeframe = '24 hours'; // Look at the last day

        // 1. Identify Service Spikes (Anomaly Detection)
        // We compare the last 24h count against a "normal" baseline (e.g., avg of last 7 days)
        const spikesQuery = `
            WITH recent_counts AS (
                SELECT service_name, COUNT(*) as incident_count
                FROM incidents
                WHERE created_at > NOW() - INTERVAL '${timeframe}'
                GROUP BY service_name
            )
            SELECT service_name, incident_count
            FROM recent_counts
            WHERE incident_count > 5 -- Threshold for a "spike"
            ORDER BY incident_count DESC;
        `;
        const spikes = await pool.query(spikesQuery);

        // 2. Cluster Incidents by Root Cause (Pattern Detection)
        // We use the pgvector <=> operator to group incidents that are very close to each other
        const clustersQuery = `
            SELECT 
                a.title as representative_title,
                COUNT(b.id) as cluster_size,
                ARRAY_AGG(b.id) as incident_ids
            FROM incidents a
            JOIN incidents b ON (a.embedding <=> b.embedding) < 0.15 
            WHERE a.created_at > NOW() - INTERVAL '${timeframe}'
              AND b.created_at > NOW() - INTERVAL '${timeframe}'
              AND a.id != b.id
            GROUP BY a.id
            HAVING COUNT(b.id) > 2
            ORDER BY cluster_size DESC
            LIMIT 5;
        `;
        const clusters = await pool.query(clustersQuery);

        res.json({
            summary: "Pattern analysis complete.",
            anomalies: spikes.rows.map(s => ({
                service: s.service_name || "Unknown",
                message: `High incident volume detected: ${s.incident_count} events.`,
                severity: s.incident_count > 10 ? "Critical" : "Warning"
            })),
            clusters: clusters.rows.map(c => ({
                root_cause_candidate: c.representative_title,
                count: c.cluster_size,
                affected_ids: c.incident_ids
            }))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to run pattern detection." });
    }
});

app.get("/analytics/incidents-summary", async (req, res) => {
    try {
        const { clusters, spikes } = await detectPatterns();

        res.json({
            timestamp: new Date(),
            active_patterns: clusters.map(c => ({
                insight: `Potential Root Cause: "${c.pattern_lead}"`,
                impact: `${c.cluster_size} incidents affected`,
                ids: c.related_incident_ids
            })),
            anomalies: spikes.map(s => ({
                service: s.service_name,
                alert: `Abnormal spike detected! ${s.current_count} incidents in the last hour (Baseline: ${s.avg_count.toFixed(1)}/hr).`
            }))
        });
    } catch (err) {
        res.status(500).send("Failed to fetch pattern data.");
    }
});

app.get("/analytics/clusters", async (req, res) => {
    try {
        // This query finds the "head" of a cluster and lists all its siblings
        const query = `
            WITH ClusterAnalysis AS (
                SELECT 
                    i1.id as lead_id,
                    i1.title as lead_title,
                    i2.id as related_id,
                    i2.title as related_title
                FROM incidents i1
                JOIN incidents i2 ON (i1.embedding <=> i2.embedding) < 0.15
                WHERE i1.id != i2.id 
                AND i1.created_at > NOW() - INTERVAL '24 hours'
            )
            SELECT 
                lead_title, 
                COUNT(related_id) as cluster_size, 
                ARRAY_AGG(related_id) as incident_ids
            FROM ClusterAnalysis
            GROUP BY lead_id, lead_title
            HAVING COUNT(related_id) > 0
            ORDER BY cluster_size DESC;
        `;

        const result = await pool.query(query);

        res.json({
            summary: `Found ${result.rows.length} recurring patterns.`,
            patterns: result.rows.map(row => ({
                root_cause_candidate: row.lead_title,
                count: parseInt(row.cluster_size) + 1, // +1 to include the lead itself
                affected_incidents: row.incident_ids
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error analyzing patterns");
    }
});

// Endpoint to create a shift - add this near your other POST routes
// Endpoint to create a shift - add this near your other POST routes
app.post("/api/on-call/shifts", async (req, res) => {
  // 1. Destructure the values from the request body
  const { project_id, user_id, start_time, end_time } = req.body;

  // 2. Add a simple check to make sure they aren't missing
  if (!project_id || !user_id || !start_time || !end_time) {
      return res.status(400).json({ error: "Missing required fields: project_id, user_id, start_time, or end_time" });
  }

  try {
      const result = await pool.query(
          `INSERT INTO on_call_schedules (project_id, user_id, start_time, end_time)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [project_id, user_id, start_time, end_time]
      );
      res.status(201).json(result.rows[0]);
  } catch (err) {
      console.error("Database Error:", err.message); // This shows the REAL error in your terminal
      res.status(500).json({ error: "Failed to create on-call shift", details: err.message });
  }
});

app.post("/incidents", async (req, res) => {
  const { title, description, environment = "Prod", project_id, created_by } = req.body;

  if (!project_id) {
    return res.status(400).json({ error: "project_id is required" });
  }

  // --- 1. SET DEFAULTS ---
  let severity = calculateSeverity(title, description); 
  let embedding = new Array(768).fill(0);
  let aiStatus = "success";

  try {
    // --- 2. TRY AI SERVICE ---
    const aiResponse = await axios.post("http://127.0.0.1:8000/analyze", {
      text: `${title} ${description}`
    });
    severity = aiResponse.data.severity;
    embedding = aiResponse.data.embedding;
  } catch (err) {
    console.warn("⚠️ AI Service offline. Falling back to local severity.");
    aiStatus = "offline_fallback";
  }

  try {
    // --- 3. ON-CALL AUTO-ASSIGNMENT ---
    // Check if someone is on call for this project right now
    const autoAssignedId = await getCurrentResponder(project_id);
    const finalAssignedTo = req.body.assigned_to || autoAssignedId;

    // --- 4. DATABASE INSERTION ---
    const slaDeadline = calculateSlaDeadline(severity);
    const creatorId = req.user?.id || created_by || null; 

    const result = await pool.query(
      `INSERT INTO incidents (title, description, severity, status, sla_deadline, embedding, environment, project_id, created_by, assigned_to)
       VALUES ($1, $2, $3, 'Open', $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title, description, severity, slaDeadline, JSON.stringify(embedding), environment, project_id, creatorId, finalAssignedTo]
    );

    const newIncident = result.rows[0];

    // --- 5. LOGGING & INSIGHTS ---
    if (autoAssignedId && !req.body.assigned_to) {
        await logActivity(newIncident.id, "Incident Auto-Assigned", null, { assigned_to: autoAssignedId });
    }
    let similarCases = [];
  if (aiStatus === "success") {
  similarCases = await findSimilarIncidents(
    embedding,
    newIncident.id,
    title
  );
}
    res.status(201).json({
      incident: newIncident,
      ai_insights: {
        status: aiStatus,
        predicted_severity: severity,
        similar_cases: similarCases
      },
      on_call: autoAssignedId ? "Auto-assigned to active responder" : "No active responder found"
    });

  } catch (dbErr) {
    console.error("❌ Database Error:", dbErr.message);
    res.status(500).json({ error: "Database error", details: dbErr.message });
  }
});
// Endpoint to assign an incident to a user
app.post("/incidents/:id/assign", async (req, res) => {
    try {
      const { id } = req.params;
      const { assigned_to, assigned_by = "system" } = req.body;

      if (!assigned_to) return res.status(400).json({ message: "assigned_to is required" });

      // Fetch incident
      const incidentResult = await pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
      if (incidentResult.rows.length === 0) return res.status(404).json({ message: "Incident not found" });

      const incident = incidentResult.rows[0];
      const oldAssigned = incident.assigned_to;

      // Update assignment
      await pool.query("UPDATE incidents SET assigned_to = $1, acknowledged_at = NULL WHERE id = $2", [assigned_to, id]);

      // Insert assignment history
      await pool.query(
        `INSERT INTO incident_assignments (incident_id, assigned_to, assigned_by)
         VALUES ($1, $2, $3)`,
        [id, assigned_to, assigned_by]
      );

      // Log activity
      await logActivity(id, "Incident Assigned", { assigned_to: oldAssigned }, { assigned_to });

      res.json({ message: `Incident assigned to ${assigned_to} successfully` });

    } catch (err) {
      console.error(err);
      res.status(500).send(err.message || "Error assigning incident");
    }
});

// Endpoint to add a comment to an incident
app.post("/incidents/:id/comments", async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id, message } = req.body;

      if (!user_id || !message) return res.status(400).json({ message: "user_id and message are required" });

      // Check if incident exists
      const incidentResult = await pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
      if (incidentResult.rows.length === 0) return res.status(404).json({ message: "Incident not found" });

      // Insert comment
      const commentResult = await pool.query(
        `INSERT INTO incident_comments (incident_id, user_id, message)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, user_id, message]
      );

      // Log activity
      await logActivity(id, "Comment Added", null, commentResult.rows[0], user_id);

      res.status(201).json(commentResult.rows[0]);

    } catch (err) {
      console.error(err);
      res.status(500).send(err.message || "Error adding comment");
    }
});

// Add this to index.js
app.post("/projects", async (req, res) => {
  const { name, workflow_id } = req.body;

  try {
      const result = await pool.query(
          "INSERT INTO projects (name, workflow_id) VALUES ($1, $2) RETURNING *",
          [name, workflow_id]
      );
      res.status(201).json(result.rows[0]);
  } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create project. Check if workflow_id exists." });
  }
});

// Also helpful: Get all projects
app.get("/projects", async (req, res) => {
  try {
      const result = await pool.query("SELECT * FROM projects");
      res.json(result.rows);
  } catch (err) {
      res.status(500).send("Error fetching projects");
  }
});

// Endpoint to update an incident
app.put("/incidents/:id",protect, async (req, res) => {
  try {
    console.log("Logged in user:", req.user);
    console.log("Logged in user role:", req.user?.role);
    const { id } = req.params;
    const { title, description, severity, status, environment, attachments } = req.body;

    // 🔎 Fetch existing incident
    const incidentResult = await pool.query(
      "SELECT * FROM incidents WHERE id = $1",
      [id]
    );

    if (incidentResult.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }

    const incident = incidentResult.rows[0];

    // ===============================
    // 🔒 STATUS TRANSITION VALIDATION
    // ===============================
    if (status && status !== incident.status) {
      const userRole = req.user?.role || "engineer";

      const isAllowed = await validateTransition(
        id,
        status,
        userRole
      );

      if (!isAllowed) {
        return res.status(400).json({
          message: `Illegal transition: ${incident.status} → ${status}`
        });
      }

      // 🚨 Prevent Investigating without assignment
      if (status === "Investigating" && !incident.assigned_to) {
        return res.status(400).json({
          message: "Incident must be assigned before investigation"
        });
      }
    }

    // ===============================
    // 🔥 SEVERITY + SLA CALCULATION
    // ===============================
    const newSeverity =
      severity ||
      calculateSeverity(
        title || incident.title,
        description || incident.description
      );

    let slaDeadline = incident.sla_deadline;

    if (newSeverity !== incident.severity) {
      slaDeadline = calculateSlaDeadline(newSeverity);
    }

    const newSlaStatus = checkSla({
      ...incident,
      sla_deadline: slaDeadline
    });

    // ===============================
    // ⏱ STAGE TIMESTAMPS
    // ===============================
    let acknowledgedAt = incident.acknowledged_at;
    let resolvedAt = incident.resolved_at;
    let postmortemAt = incident.postmortem_completed_at;

    if (status === "Acknowledged" && !incident.acknowledged_at) {
      acknowledgedAt = new Date();
    }

    if (status === "Resolved" && !incident.resolved_at) {
      resolvedAt = new Date();
    }

    if (status === "Postmortem" && !incident.postmortem_completed_at) {
      postmortemAt = new Date();
    }

    // ===============================
    // 📝 DATABASE UPDATE (ONLY ONCE)
    // ===============================
    const result = await pool.query(
      `UPDATE incidents
       SET title=$1,
           description=$2,
           severity=$3,
           status=$4,
           sla_deadline=$5,
           sla_status=$6,
           environment=$7,
           attachments=$8,
           acknowledged_at=$9,
           resolved_at=$10,
           postmortem_completed_at=$11
       WHERE id=$12
       RETURNING *`,
      [
        title || incident.title,
        description || incident.description,
        newSeverity,
        status || incident.status,
        slaDeadline,
        newSlaStatus,
        environment || incident.environment,
        attachments || incident.attachments,
        acknowledgedAt,
        resolvedAt,
        postmortemAt,
        id
      ]
    );

    // ===============================
    // ⚡ CASCADE RESOLUTION TO DUPLICATES
    // ===============================
    if (status === "Resolved") {

      const childrenResult = await pool.query(
        `UPDATE incidents
         SET status = 'Resolved',
             resolved_at = $1,
             resolution_notes = $2
         WHERE parent_incident_id = $3
         AND status != 'Resolved'
         RETURNING id`,
        [
          resolvedAt,
          `Automatically resolved via Parent Incident #${id}`,
          id
        ]
      );

      const childCount = childrenResult.rowCount;

      console.log(
        `Successfully resolved ${childCount} duplicate incidents linked to #${id}`
      );
    }

    // ===============================
    // 📜 ACTIVITY LOGGING
    // ===============================
    await logActivity(
      id,
      "Incident Updated",
      incident,
      result.rows[0],
      req.user?.id || "system"
    );

    res.json({
      message: "Incident updated successfully",
      incident: result.rows[0]
    });

  } catch (err) {
    console.error(err);

    if (
      err.message.includes("Illegal transition") ||
      err.message.includes("not allowed")
    ) {
      return res.status(400).json({ message: err.message });
    }

    res.status(500).json({
      error: err.message || "Error updating incident"
    });
  }
});

app.post("/api/incidents/:id/generate-summary", protect, async (req, res) => {
  try {
    const { id } = req.params;

    if (!["manager", "admin"].includes(req.user?.role)) {
      return res.status(403).json({
        message: "Only managers can generate summaries."
      });
    }

    // 1️⃣ Fetch incident details
    const incidentResult = await pool.query(
      `SELECT id, title, severity, created_at
       FROM incidents
       WHERE id = $1`,
      [id]
    );

    if (incidentResult.rows.length === 0) {
      return res.status(404).json({ message: "Incident not found" });
    }

    const incident = incidentResult.rows[0];

    // 2️⃣ Fetch activity logs
    const logsResult = await pool.query(
      `SELECT action_type, old_value, new_value, performed_by, created_at
       FROM incident_activity
       WHERE incident_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    if (logsResult.rows.length === 0) {
      return res.status(404).json({
        message: "No activity logs found for this incident."
      });
    }

    const timelineLines = [];

    for (const log of logsResult.rows) {

      let change = "";

      let oldVal = {};
      let newVal = {};

      try {
        oldVal = log.old_value ? JSON.parse(log.old_value) : {};
        newVal = log.new_value ? JSON.parse(log.new_value) : {};
      } catch {}

      if (log.action_type === "Incident Assigned") {
        change = `assigned to user ${newVal.assigned_to || "unknown"}`;
      }

      if (log.action_type === "Incident Updated") {

        if (oldVal.status !== newVal.status && newVal.status) {
          change = `status changed from ${oldVal.status} → ${newVal.status}`;
        }

        else if (oldVal.severity !== newVal.severity && newVal.severity) {
          change = `severity changed from ${oldVal.severity} → ${newVal.severity}`;
        }

      }

      if (!change) continue;

      const time = new Date(log.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

      timelineLines.push(`• ${time} — ${change}`);
    }

    const timeline = timelineLines.join("\n");

    // 3️⃣ Calculate incident duration
    const startTime = logsResult.rows[0].created_at;
    const endTime = logsResult.rows[logsResult.rows.length - 1].created_at;

    const durationMinutes = Math.round(
      (new Date(endTime) - new Date(startTime)) / 60000
    );

    // 4️⃣ Generate structured report
    const generatedSummary = `
Incident Report

Incident ID: ${incident.id}
Title: ${incident.title}
Severity: ${incident.severity}
Duration: ${durationMinutes} minutes

Timeline of events

${timeline}

Root Cause
Root cause analysis pending. Likely infrastructure issue.

Resolution
Engineering team investigated the issue and restored the affected service.

Action Items
• Add monitoring for the affected service
• Improve alert thresholds
• Document incident response steps
`;

    const rootCause = "Root cause analysis pending.";

    // 5️⃣ Save report
    const savedReport = await pool.query(
      `INSERT INTO incident_postmortems
       (incident_id, summary, root_cause, generated_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [id, generatedSummary, rootCause, req.user.id]
    );

    res.json({
      message: "Post-mortem generated successfully",
      report: savedReport.rows[0]
    });

  } catch (err) {
    console.error("Summary generation failed:", err);

    res.status(500).json({
      error: "Failed to generate incident summary."
    });
  }
});
// Endpoint to delete an incident
app.delete("/incidents/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const result = await pool.query("DELETE FROM incidents WHERE id = $1 RETURNING *", [id]);

      if (result.rows.length === 0) return res.status(404).json({ message: "Incident not found" });

      res.json({ message: "Incident deleted successfully" });

    } catch (err) {
      console.error(err);
      res.status(500).send("Error deleting incident");
    }
});
// Escalation background worker
setInterval(() => {
  runEscalationCheck();
}, 5 * 60 * 1000); // every 5 minutes
// Start server on port 3000
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});