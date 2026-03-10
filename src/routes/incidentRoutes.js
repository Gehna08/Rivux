const express = require("express");
const router = express.Router();
// Import both middleware functions correctly
const { protect } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const {
    createIncident,
    getAllIncidents,
    getIncidentById,
    assignIncident,
    deleteIncident,
} = require("../controllers/incidentController");

// ✅ 1. Use 'protect' instead of 'authMiddleware' (which was an object)
router.get("/test", protect, (req, res) => {
    res.json({ message: "Protected route working", user: req.user });
});

// ✅ 2. Combine these or remove the duplicate. 
// I've removed the empty one and used the one that calls createIncident
router.post("/", protect, createIncident);

// ✅ 3. Update all other routes to use 'protect'
router.get("/", protect, getAllIncidents);
router.get("/:id", protect, getIncidentById);

// ✅ 4. Fix role-based routes
router.post("/assign", protect, roleMiddleware("admin", "manager"), assignIncident);
router.delete("/:id", protect, roleMiddleware("admin"), deleteIncident);

module.exports = router;