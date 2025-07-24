const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkAccess = require('../middleware/checkAccess');

// POST /onboarding/start → HR initiates onboarding
router.post('/start', verifyToken, checkAccess(3), async (req, res) => {
    // Logic to initiate onboarding
});

// PUT /onboarding/:id/task → Employee completes task
router.put('/:id/task', verifyToken, async (req, res) => {
    // Logic to complete onboarding task
});

// POST /offboarding/start → Admin offboards
router.post('/offboarding/start', verifyToken, checkAccess(5), async (req, res) => {
    // Logic to initiate offboarding
});

module.exports = router;
