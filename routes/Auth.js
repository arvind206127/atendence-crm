const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'apna_secret_key_yahan_rakhein';

// 1. Signup Route
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email is already registered!" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const count = await User.countDocuments();
    const empId = `EMP${String(101 + count).padStart(3, '0')}`;

    const newUser = new User({ 
      empId, 
      employeeId: empId, // Both fields set for compatibility
      name, 
      email, 
      password: hashedPassword 
    });
    await newUser.save();

    const token = jwt.sign({ id: newUser._id, empId: newUser.empId }, JWT_SECRET, { expiresIn: '1d' });

    res.status(201).json({ success: true, token, empId, name });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Login Route (FIXED FOR CRM EMPLOYEES)
router.post('/login', async (req, res) => {
  try {
    // Read both possible payload keys from frontend
    const employeeInput = req.body.employeeId || req.body.empId;
    const { password } = req.body;

    if (!employeeInput || !password) {
      return res.status(400).json({ success: false, message: "Employee ID and Password are required" });
    }

    const trimmedId = employeeInput.trim();

    // Query both 'employeeId' and 'empId' with case-insensitive regex
    const user = await User.findOne({
      $or: [
        { employeeId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
        { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
      ]
    });

    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    // Password comparison
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    const userEmpId = user.employeeId || user.empId;
    const token = jwt.sign({ id: user._id, empId: userEmpId }, JWT_SECRET, { expiresIn: '1d' });

    res.json({ success: true, token, empId: userEmpId, name: user.name });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;