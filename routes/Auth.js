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

    // Determine clean employee ID (never return 'undefined')
    let resolvedEmpId = user.empId || user.employeeId;
    if (!resolvedEmpId || resolvedEmpId === 'undefined' || resolvedEmpId === 'null') {
      // If user typed an ID at login that is not an email, use that entered ID
      if (trimmedId && !trimmedId.includes('@')) {
        resolvedEmpId = trimmedId;
      } else if (user.name) {
        resolvedEmpId = `EMP-${user.name.replace(/\s+/g, '').toUpperCase()}`;
      } else {
        resolvedEmpId = `EMP${String(user._id).slice(-4).toUpperCase()}`;
      }

      // Persist corrected empId to User document
      try {
        await User.updateOne({ _id: user._id }, { $set: { empId: resolvedEmpId } });
      } catch (e) {
        console.warn('Failed to persist empId on user:', e.message);
      }
    }

    // Auto-repair past attendance records that had empId as 'undefined'
    const Attendance = require('../models/Attendance');
    try {
      await Attendance.updateMany(
        {
          $or: [{ empId: 'undefined' }, { empId: null }, { empId: '' }],
          empName: user.name
        },
        { $set: { empId: resolvedEmpId } }
      );
    } catch (e) {
      // Ignore background repair error
    }

    const token = jwt.sign({ id: user._id, empId: resolvedEmpId }, JWT_SECRET, { expiresIn: '1d' });

    res.json({
      success: true,
      token,
      empId: resolvedEmpId,
      name: user.name,
      email: user.email
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Logout Route (POST/GET /api/auth/logout) - Automatically marks logoutTime on attendance
router.all('/logout', async (req, res) => {
  try {
    let empInput = req.body?.empId || req.body?.employeeId || req.query?.empId || req.query?.employeeId || req.body?.email || req.query?.email || req.body?.name || req.query?.name;

    // Check Authorization header token if body/query is empty
    if (!empInput && req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.empId) empInput = decoded.empId;
      } catch (e) {}
    }

    const Attendance = require('../models/Attendance');
    const now = new Date();
    const logoutTimeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

    let updatedRecord = null;

    if (empInput) {
      const trimmed = String(empInput).trim();
      const user = await User.findOne({
        $or: [
          { empId: { $regex: new RegExp(`^${trimmed}$`, 'i') } },
          { name: { $regex: new RegExp(`^${trimmed}$`, 'i') } },
          { email: { $regex: new RegExp(`^${trimmed}$`, 'i') } }
        ]
      });

      const searchId = (user && user.empId) ? user.empId : trimmed;
      const searchName = user ? user.name : trimmed;

      const conditions = [];
      if (searchId) conditions.push({ empId: { $regex: new RegExp(`^${searchId}$`, 'i') } });
      if (searchName) conditions.push({ empName: { $regex: new RegExp(`^${searchName}$`, 'i') } });

      // Find latest open record (where punchOut is null)
      updatedRecord = await Attendance.findOne({
        $or: conditions,
        punchOut: null
      }).sort({ createdAt: -1 });

      // Fallback: latest record of this employee
      if (!updatedRecord) {
        updatedRecord = await Attendance.findOne({
          $or: conditions
        }).sort({ createdAt: -1 });
      }

      if (updatedRecord) {
        updatedRecord.punchOut = now;
        updatedRecord.logoutTime = logoutTimeStr;
        await updatedRecord.save();
      }
    } else {
      // If no ID passed, try updating the most recent attendance record where punchOut is null
      updatedRecord = await Attendance.findOne({ punchOut: null }).sort({ createdAt: -1 });
      if (updatedRecord) {
        updatedRecord.punchOut = now;
        updatedRecord.logoutTime = logoutTimeStr;
        await updatedRecord.save();
      }
    }

    res.json({
      success: true,
      message: 'Logged out successfully and logout time recorded.',
      logoutTime: logoutTimeStr,
      data: updatedRecord
    });
  } catch (err) {
    console.error('Logout Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;