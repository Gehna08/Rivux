const pool = require("../config/db");

/**
 * Finds the user currently scheduled for a specific project.
 * @param {number} projectId 
 * @returns {number|null} user_id of the responder
 */
const getCurrentResponder = async (projectId) => {
    const now = new Date();
    try {
        const result = await pool.query(
            `SELECT user_id FROM on_call_schedules 
             WHERE project_id = $1 
             AND $2 BETWEEN start_time AND end_time 
             ORDER BY start_time ASC LIMIT 1`,
            [projectId, now]
        );

        return result.rows.length > 0 ? result.rows[0].user_id : null;
    } catch (err) {
        console.error("Error fetching on-call user:", err);
        return null;
    }
};

module.exports = { getCurrentResponder };