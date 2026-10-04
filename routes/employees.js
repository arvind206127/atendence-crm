const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Attendance = require('../models/Attendance');

/**
 * 1. GET /api/employees/all
 * Sabhi employees ka complete data (User Profile + Attendance History + Total Attendance Count)
 */
router.get('/all', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Registered users
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const userByName = {};
    const userByEmpId = {};
    users.forEach(u => {
      if (u.name) userByName[u.name.toLowerCase().trim()] = u;
      if (u.empId && u.empId !== 'undefined') userByEmpId[u.empId.toLowerCase().trim()] = u;
    });

    // Sabhi attendance records
    const attendances = await Attendance.find().sort({ createdAt: -1 });

    // Attendances ko empId ke hisaab se group karna aur image URLs clean banana
    const attendanceMap = {};
    attendances.forEach((att) => {
      let id = (att.empId || '').trim();
      if (!id || id === 'undefined' || id === 'null') {
        const u = userByName[(att.empName || '').toLowerCase().trim()];
        id = (u && u.empId && u.empId !== 'undefined') ? u.empId : (att.empName ? `EMP-${att.empName.toUpperCase()}` : 'EMP101');
      }

      if (!attendanceMap[id]) {
        attendanceMap[id] = [];
      }
      const obj = att.toObject();
      const hasImg = !!(obj.selfie || obj.imageUrl);
      obj.imageUrl = hasImg ? `/api/attendance/image/${obj._id}` : '';
      obj.selfie = obj.imageUrl;
      obj.empId = id;

      const inDate = obj.punchIn ? new Date(obj.punchIn) : new Date(obj.createdAt || Date.now());
      const outDate = obj.punchOut ? new Date(obj.punchOut) : null;
      obj.loginTime = obj.loginTime || inDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      obj.logoutTime = obj.logoutTime || (outDate ? outDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : null);
      obj.punchTime = obj.loginTime;
      obj.punchInTime = obj.loginTime;
      obj.punchOutTime = obj.logoutTime;

      attendanceMap[id].push(obj);
    });

    const fullEmployeeData = [];
    const processedEmpIds = new Set();

    // Registered users ka data map karna
    for (const u of users) {
      const empId = u.empId;
      processedEmpIds.add(empId);
      const userAttendances = attendanceMap[empId] || [];

      fullEmployeeData.push({
        empId: u.empId,
        name: u.name,
        email: u.email,
        registeredAt: u.createdAt,
        totalAttendance: userAttendances.length,
        latestAttendance: userAttendances[0] || null,
        attendanceHistory: userAttendances
      });
    }

    // Jo employees Attendance table me hain par User collection me nahi
    for (const [empId, records] of Object.entries(attendanceMap)) {
      if (!processedEmpIds.has(empId)) {
        fullEmployeeData.push({
          empId: empId,
          name: records[0]?.empName || 'Employee',
          email: 'N/A',
          registeredAt: null,
          totalAttendance: records.length,
          latestAttendance: records[0] || null,
          attendanceHistory: records
        });
      }
    }

    res.status(200).json({
      success: true,
      totalEmployees: fullEmployeeData.length,
      data: fullEmployeeData
    });
  } catch (err) {
    console.error('Error fetching employee full data:', err);
    res.status(500).json({
      success: false,
      message: 'Server error fetching employee full data',
      error: err.message
    });
  }
});

/**
 * 2. GET /api/employees/:empId
 * Kisi specific employee ka pura data (Details + Attendance records)
 */
router.get('/:empId', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const empId = req.params.empId.trim();

    const user = await User.findOne({
      $or: [
        { empId: empId },
        { empId: empId.toUpperCase() },
        { email: empId.toLowerCase() }
      ]
    }).select('-password');

    const rawAttendances = await Attendance.find({
      $or: [
        { empId: empId },
        { empId: empId.toUpperCase() }
      ]
    }).sort({ createdAt: -1 });

    if (!user && rawAttendances.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Employee with ID ${empId} not found.`
      });
    }

    const attendances = rawAttendances.map(att => {
      const obj = att.toObject();
      const hasImg = !!(obj.selfie || obj.imageUrl);
      obj.imageUrl = hasImg ? `/api/attendance/image/${obj._id}` : '';
      obj.selfie = obj.imageUrl;
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        empId: user ? user.empId : empId,
        name: user ? user.name : (attendances[0]?.empName || 'Employee'),
        email: user ? user.email : 'N/A',
        registeredAt: user ? user.createdAt : null,
        totalAttendance: attendances.length,
        latestAttendance: attendances[0] || null,
        attendanceHistory: attendances
      }
    });
  } catch (err) {
    console.error('Error fetching single employee:', err);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message
    });
  }
});

/**
 * 3. POST /api/employees/save
 * Kisi bahar ke source ya API se aaye hue employee/attendance data ko database me save karne ke liye
 */
router.post('/save', async (req, res) => {
  try {
    const input = req.body.employees || req.body.data || (Array.isArray(req.body) ? req.body : [req.body]);

    if (!input || input.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No data provided to save. Please pass an array or object.'
      });
    }

    const savedRecords = [];
    for (const item of input) {
      if (!item.empId) continue;

      if (item.location && item.selfie) {
        const att = new Attendance({
          empId: item.empId,
          empName: item.name || item.empName || 'Employee',
          status: item.status || 'Present',
          location: item.location,
          selfie: item.selfie,
          imageUrl: item.imageUrl,
          createdAt: item.createdAt ? new Date(item.createdAt) : new Date()
        });
        await att.save();
        savedRecords.push(att);
      }
    }

    res.status(201).json({
      success: true,
      message: `Successfully saved ${savedRecords.length} records into database!`,
      savedCount: savedRecords.length,
      data: savedRecords
    });
  } catch (err) {
    console.error('Error saving data to database:', err);
    res.status(500).json({
      success: false,
      message: 'Error saving data to database',
      error: err.message
    });
  }
});

module.exports = router;
