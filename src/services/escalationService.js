const pool = require("../config/db");

const severityEscalationMinutes = {
  1: 5,   // P1 → escalate in 5 min
  2: 10,  // P2 → escalate in 10 min
  3: 20   // P3 → escalate in 20 min
};

async function runEscalationCheck() {
  const client = await pool.connect();

  try {
    console.log("🔎 Checking incidents for escalation...");

    const incidents = await client.query(`
      SELECT *
      FROM incidents
      WHERE status = 'Open'
      AND escalated = FALSE
    `);

    for (const incident of incidents.rows) {

      const threshold =
        severityEscalationMinutes[incident.severity] || 15;

      const createdTime = new Date(incident.created_at);
      const now = new Date();

      const minutesPassed =
        (now - createdTime) / (1000 * 60);

      if (minutesPassed >= threshold) {

        // Find a manager to escalate to
        const manager = await client.query(`
          SELECT id
          FROM users
          WHERE role = 'manager'
          LIMIT 1
        `);

        if (manager.rows.length === 0) {
          console.log("⚠️ No manager available");
          continue;
        }

        const managerId = manager.rows[0].id;

        // Update incident
        await client.query(
          `UPDATE incidents
           SET assigned_to = $1,
               escalated = TRUE
           WHERE id = $2`,
          [managerId, incident.id]
        );

        // Log activity
        await client.query(
          `INSERT INTO incident_activity
          (incident_id, action_type, old_value, new_value, performed_by)
          VALUES ($1,$2,$3,$4,$5)`,
          [
            incident.id,
            "Incident Escalated",
            JSON.stringify({ assigned_to: incident.assigned_to }),
            JSON.stringify({ assigned_to: managerId }),
            "system"
          ]
        );

        console.log(
          `🚀 Escalated Incident #${incident.id} → Manager ${managerId}`
        );
      }
    }

  } catch (err) {
    console.error("❌ Escalation Engine Error:", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runEscalationCheck };