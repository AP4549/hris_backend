const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');

// POST /leave/request → Employee submits leave
router.post('/request', verifyToken, async (req, res) => {
    // Logic to submit leave request
});

// PUT /leave/:id/approve → Manager approves
router.put('/:id/approve', verifyToken, checkAccess(4), async (req, res) => {
    // Logic to approve leave request
});

// GET /leave/history/:empId → Fetch leave history
router.get('/history/:empId', verifyToken, async (req, res) => {
    // Logic to fetch leave history
});

// POST /attendance/log → Punch in/out
router.post('/attendance/log', verifyToken, async (req, res) => {
    // Logic to log attendance
});

module.exports = router;
