const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'apna_secret_key_yahan_rakhein';

// Login Route
router.post('/login', async (req, res) => {
  try {
    const employeeInput = req.body.employeeId || req.body.empId;
    const { password } = req.body;

    if (!employeeInput || !password) {
      return res.status(400).json({ success: false, message: "Employee ID and Password are required" });
    }

    const trimmedId = employeeInput.trim();

    // 1. Find user in database by employeeId or empId
    const user = await User.findOne({
      $or: [
        { employeeId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
        { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
      ]
    });

    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    // 2. Read 'passwordHash' or 'password' field from document
    const storedHash = user.passwordHash || user.password;

    if (!storedHash) {
      return res.status(500).json({ success: false, message: "Password hash not found in database" });
    }

    // 3. Compare entered password with stored hash
    const isMatch = await bcrypt.compare(password, storedHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    const userEmpId = user.employeeId || user.empId;
    const token = jwt.sign({ id: user._id, empId: userEmpId }, JWT_SECRET, { expiresIn: '1d' });

    res.json({ success: true, token, empId: userEmpId, name: user.name });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;