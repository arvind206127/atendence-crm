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

    const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email is already registered!" });
    }

    // Password hashing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const count = await User.countDocuments();
    const empId = `EMP${String(101 + count).padStart(3, '0')}`;

    const newUser = new User({ empId, name: name.trim(), email: email.trim().toLowerCase(), password: hashedPassword });
    await newUser.save();

    const token = jwt.sign({ id: newUser._id, empId: newUser.empId }, JWT_SECRET, { expiresIn: '1d' });

    res.status(201).json({ success: true, token, empId: newUser.empId, name: newUser.name });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Login Route
router.post('/login', async (req, res) => {
  try {
    const employeeInput = req.body.employeeId || req.body.empId;
    const { password } = req.body;

    if (!employeeInput || !password) {
      return res.status(400).json({ success: false, message: "Employee ID and Password are required" });
    }

    const trimmedId = employeeInput.trim();

    // Search by empId, employeeId, name, or email (case-insensitive)
    const user = await User.findOne({
      $or: [
        { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
        { employeeId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
        { name: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
        { email: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
      ]
    }).select('+passwordHash +password');

    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    // Read stored hash from document
    const storedHash = user.passwordHash || user.password || (user._doc && (user._doc.passwordHash || user._doc.password));

    if (!storedHash) {
      return res.status(500).json({ success: false, message: "Password hash not found in database" });
    }

    // Compare entered password with stored hash
    const isMatch = await bcrypt.compare(password, storedHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Invalid Employee ID or Password!" });
    }

    const userEmpId = user.empId || user.employeeId;
    const token = jwt.sign({ id: user._id, empId: userEmpId }, JWT_SECRET, { expiresIn: '1d' });

    res.json({ success: true, token, empId: userEmpId, name: user.name });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;