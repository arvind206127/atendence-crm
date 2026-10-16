const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'apna_secret_key_yahan_rakhein';
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'advmen_sso_shared_secret_2026_key_secure_99';
const CRM_FRONTEND_URL = (process.env.CRM_FRONTEND_URL || 'https://advmen-crm-frontend.vercel.app').replace(/\/+$/, '');
const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || 'Asia/Kolkata';

// Helper: Check 10:05 AM Cutoff & 1:30 PM Half Day Timing Rule in Asia/Kolkata
function evaluatePunchInWindow(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: ATTENDANCE_TIMEZONE,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const totalMinutes = h * 60 + m;

    // Window 1: Up to 10:05 AM -> Allowed, Present
    if (totalMinutes <= 605) {
      return { allowed: true, status: 'Present', isHalfDay: false };
    }

    // Window 2: Between 10:05 AM and 1:30 PM -> Blocked
    if (totalMinutes < 810) {
      return {
        allowed: false,
        blockedUntilHalfDay: true,
        status: 'Absent',
        nextAllowedTime: '1:30 PM',
        message: 'Subah 10:05 AM ke baad Punch In band hai! Ab lunch ke baad 1:30 PM par hi Punch In hoga aur aapka Half Day lagega.'
      };
    }

    // Window 3: 1:30 PM onwards -> Allowed, Half Day
    return {
      allowed: true,
      status: 'Half Day',
      isHalfDay: true,
      message: 'Aapne lunch ke baad punch in kiya hai (10:05 AM cutoff exceed hone par). Aapka Half Day mark ho gaya hai!'
    };
  } catch (e) {
    return { allowed: true, status: 'Present', isHalfDay: false };
  }
}

function checkIsHalfDay(date = new Date()) {
  return evaluatePunchInWindow(date).isHalfDay;
}

// Helpers for Indian Standard Time (Asia/Kolkata)
function formatCleanISTTime(dateOrStr) {
  if (!dateOrStr) return null;
  try {
    const d = new Date(dateOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('en-IN', {
        timeZone: ATTENDANCE_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    }
  } catch (e) {}
  return String(dateOrStr);
}

function getISTDayRange(dateObj = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ATTENDANCE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dateObj); // "YYYY-MM-DD"
    const startOfDay = new Date(`${parts}T00:00:00.000+05:30`);
    const endOfDay = new Date(`${parts}T23:59:59.999+05:30`);
    return { startOfDay, endOfDay, istDateStr: parts };
  } catch (e) {
    const d = new Date(dateObj);
    const start = new Date(d.setHours(0, 0, 0, 0));
    const end = new Date(d.setHours(23, 59, 59, 999));
    return { startOfDay: start, endOfDay: end, istDateStr: d.toISOString().slice(0, 10) };
  }
}

// Helper: Determine user role and corresponding dashboard target route in Sales CRM
function determineUserRoleAndTarget(user, empInput) {
  let role = 'SALES_REP';
  let target = '/employee';

  const userRoleStr = String(user?.role || '').toUpperCase();
  const empIdStr = String(empInput || user?.empId || user?.employeeId || '').toUpperCase();
  const emailStr = String(user?.email || '').toLowerCase();
  const nameStr = String(user?.name || '').toLowerCase();

  const isAdmin = userRoleStr.includes('ADMIN') || 
                  empIdStr.includes('ADMIN') || 
                  emailStr.includes('admin') || 
                  nameStr === 'admin';

  if (isAdmin) {
    role = userRoleStr.includes('SUPER') ? 'SUPER_ADMIN' : 'ORG_ADMIN';
    target = '/roles/super-admin';
  } else {
    // Default for employees: SALES_REP role directs to /employee dashboard in Sales CRM
    role = 'SALES_REP';
    target = '/employee';
  }

  return { role, target };
}

// Helper: Generate signed SSO token and CRM dashboard redirect URL based on role
function createSsoPayloadAndToken(user, fallbackId, fallbackName, explicitTarget) {
  const resolvedEmpId = (user && (user.empId || user.employeeId)) ? (user.empId || user.employeeId) : fallbackId;
  const resolvedName = (user && user.name) ? user.name : (fallbackName || 'Employee');
  const cleanIdStr = String(resolvedEmpId || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolvedEmail = (user && user.email) ? user.email : `${cleanIdStr || 'user'}@advmen.com`;
  const resolvedId = user ? String(user._id) : `usr_${cleanIdStr || 'id'}`;

  const { role, target: roleTarget } = determineUserRoleAndTarget(user, resolvedEmpId);
  const target = explicitTarget || roleTarget;

  const payload = {
    id: resolvedId,
    name: resolvedName,
    email: resolvedEmail,
    role: role,
    organizationId: 'org_advmen_platform',
    organizationName: 'ADVMEN Workspace',
    employeeId: resolvedEmpId,
    empId: resolvedEmpId,
    permissions: []
  };

  const ssoToken = jwt.sign(payload, SSO_SHARED_SECRET, { expiresIn: '8h' });
  const redirectUrl = `${CRM_FRONTEND_URL}/auth/sso?token=${encodeURIComponent(ssoToken)}&target=${encodeURIComponent(target)}`;

  return { ssoToken, redirectUrl, user: payload, role, target, crmFrontendUrl: CRM_FRONTEND_URL };
}

// 1. Signup Route
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({
      $or: [
        { email: cleanEmail },
        { normalizedEmail: cleanEmail }
      ]
    });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email is already registered!" });
    }

    // Password hashing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const count = await User.countDocuments();
    const empId = `EMP${String(101 + count).padStart(3, '0')}`;

    const newUser = new User({ 
      empId, 
      name: name.trim(), 
      email: cleanEmail,
      normalizedEmail: cleanEmail,
      organizationId: 'org_advmen_platform',
      password: hashedPassword 
    });
    await newUser.save();

    const token = jwt.sign({ id: newUser._id, empId: newUser.empId }, JWT_SECRET, { expiresIn: '1d' });
    const ssoData = createSsoPayloadAndToken(newUser, newUser.empId, newUser.name);

    res.status(201).json({
      success: true,
      token,
      ssoToken: ssoData.ssoToken,
      crmDashboardUrl: ssoData.redirectUrl,
      empId: newUser.empId,
      name: newUser.name
    });
  } catch (err) {
    console.error("Signup Error:", err);
    if (err.code === 11000) {
      // Check if it was empId collision, increment and retry once
      try {
        const cleanEmail = (req.body.email || '').trim().toLowerCase();
        const altId = `EMP${Date.now().toString().slice(-4)}`;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(req.body.password, salt);
        const retryUser = new User({
          empId: altId,
          name: (req.body.name || '').trim(),
          email: cleanEmail,
          normalizedEmail: cleanEmail,
          organizationId: 'org_advmen_platform',
          password: hashedPassword
        });
        await retryUser.save();
        const token = jwt.sign({ id: retryUser._id, empId: retryUser.empId }, JWT_SECRET, { expiresIn: '1d' });
        const ssoData = createSsoPayloadAndToken(retryUser, retryUser.empId, retryUser.name);
        return res.status(201).json({
          success: true,
          token,
          ssoToken: ssoData.ssoToken,
          crmDashboardUrl: ssoData.redirectUrl,
          empId: retryUser.empId,
          name: retryUser.name
        });
      } catch (retryErr) {
        return res.status(400).json({ success: false, message: "A user with this email or account already exists." });
      }
    }
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
    const ssoData = createSsoPayloadAndToken(user, resolvedEmpId, user.name);

    const timeRule = evaluatePunchInWindow(new Date());
    let notificationMessage = null;
    if (!timeRule.allowed) {
      notificationMessage = timeRule.message;
    } else if (timeRule.isHalfDay) {
      notificationMessage = 'Aap 1:30 PM ke baad login / punch kar rahe hain. Aapka Half Day lag gaya hai!';
    }

    // --- SAVE ATTENDANCE TO DATABASE ON LOGIN ONLY IF ALLOWED ---
    let savedAttendanceRecord = null;
    if (timeRule.allowed) {
      try {
        const now = new Date();
        const loginTimeStr = formatCleanISTTime(now);
        const { startOfDay, endOfDay, istDateStr } = getISTDayRange(now);

        const idRegex = new RegExp(`^${resolvedEmpId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const nameRegex = user.name ? new RegExp(`^${user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null;

        const orConds = [
          { empId: idRegex },
          { employeeId: idRegex }
        ];
        if (nameRegex) {
          orConds.push({ empName: nameRegex });
        }

        savedAttendanceRecord = await Attendance.findOne({
          $and: [
            { $or: orConds },
            {
              $or: [
                { date: istDateStr },
                { createdAt: { $gte: startOfDay, $lte: endOfDay } },
                { punchIn: { $gte: startOfDay, $lte: endOfDay } }
              ]
            }
          ]
        }).sort({ createdAt: -1 });

        if (!savedAttendanceRecord) {
          // Create and save attendance record immediately in database
          savedAttendanceRecord = new Attendance({
            empId: resolvedEmpId,
            empName: user.name || 'Employee',
            organizationId: user.organizationId || 'org_advmen_platform',
            status: timeRule.status,
            isHalfDay: timeRule.isHalfDay,
            halfDayReason: timeRule.isHalfDay ? 'Login at/after 1:30 PM (after 10:05 AM cutoff)' : '',
            halfDayNotificationSent: timeRule.isHalfDay,
            punchIn: now,
            punchOut: null,
            loginTime: loginTimeStr,
            logoutTime: null,
            date: istDateStr,
            location: {
              address: 'NX One, Techzone 4, Greater Noida West',
              lat: 28.59867,
              lng: 77.43187,
              accuracy: 15,
              distanceMeters: 0
            },
            isOnLunch: false
          });
          await savedAttendanceRecord.save();
        } else {
          // Record exists, ensure status and isHalfDay reflect rule
          if (timeRule.isHalfDay && !savedAttendanceRecord.isHalfDay) {
            savedAttendanceRecord.isHalfDay = true;
            savedAttendanceRecord.status = 'Half Day';
            savedAttendanceRecord.halfDayReason = 'Login at/after 1:30 PM (after 10:05 AM cutoff)';
            await savedAttendanceRecord.save();
          }
        }

        // Explicit direct sync to singular 'attendance' collection
        if (savedAttendanceRecord) {
          try {
            const cleanDoc = savedAttendanceRecord.toObject ? savedAttendanceRecord.toObject() : { ...savedAttendanceRecord };
            await mongoose.connection.db.collection('attendances').updateOne(
              {
                $or: [
                  { _id: savedAttendanceRecord._id },
                  { empId: idRegex, date: istDateStr }
                ]
              },
              { $set: cleanDoc },
              { upsert: true }
            );
          } catch (syncErr) {}
        }
      } catch (attErr) {
        console.error('Error saving attendance on login:', attErr.message);
      }
    }

    res.json({
      success: true,
      token,
      ssoToken: ssoData.ssoToken,
      crmDashboardUrl: ssoData.redirectUrl,
      empId: resolvedEmpId,
      name: user.name,
      email: user.email,
      isHalfDay: timeRule.isHalfDay,
      isBlockedUntil130: !timeRule.allowed,
      notificationMessage: notificationMessage,
      attendanceRecordId: savedAttendanceRecord?._id,
      attendanceSaved: Boolean(savedAttendanceRecord)
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

// 4. SSO Route (GET/POST /api/auth/crm-sso, /api/auth/sso-token, /api/auth/sso-redirect)
// Generates secure SSO JWT using SSO_SHARED_SECRET and redirects or returns CRM dashboard URL
router.all(['/crm-sso', '/sso-token', '/sso-redirect'], async (req, res) => {
  try {
    let empInput = req.body?.empId || req.body?.employeeId || req.query?.empId || req.query?.employeeId || req.body?.email || req.query?.email || req.body?.name || req.query?.name;

    // Check Authorization header token if body/query is empty
    if (!empInput && req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && (decoded.empId || decoded.id)) {
          empInput = decoded.empId || decoded.id;
        }
      } catch (e) {}
    }

    let user = null;
    if (empInput) {
      const trimmed = String(empInput).trim();
      user = await User.findOne({
        $or: [
          { empId: { $regex: new RegExp(`^${trimmed}$`, 'i') } },
          { employeeId: { $regex: new RegExp(`^${trimmed}$`, 'i') } },
          { name: { $regex: new RegExp(`^${trimmed}$`, 'i') } },
          { email: { $regex: new RegExp(`^${trimmed}$`, 'i') } }
        ]
      });
    }

    const requestedTarget = req.query?.target || req.body?.target;
    const ssoData = createSsoPayloadAndToken(user, empInput || 'EMP-USER', user ? user.name : 'Employee', requestedTarget);
    const redirectUrl = ssoData.redirectUrl;

    // If browser GET navigation without JSON expectation, redirect directly
    const wantsJson = req.xhr || req.query?.format === 'json' || (req.headers.accept && req.headers.accept.includes('application/json'));
    if (!wantsJson && req.method === 'GET') {
      return res.redirect(redirectUrl);
    }

    res.json({
      success: true,
      token: ssoData.ssoToken,
      ssoToken: ssoData.ssoToken,
      redirectUrl,
      role: ssoData.role,
      target: ssoData.target,
      crmFrontendUrl: CRM_FRONTEND_URL,
      user: ssoData.user
    });
  } catch (err) {
    console.error('SSO Token Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;