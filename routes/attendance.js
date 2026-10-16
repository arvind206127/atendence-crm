const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Report = require('../models/Report');

// Configuration from Environment
const OFFICE_LATITUDE = parseFloat(process.env.OFFICE_LATITUDE) || 28.600556;
const OFFICE_LONGITUDE = parseFloat(process.env.OFFICE_LONGITUDE) || 77.432778;
const OFFICE_RADIUS_METERS = parseFloat(process.env.OFFICE_RADIUS_METERS) || 50;
const GPS_MAX_ACCURACY_METERS = parseFloat(process.env.GPS_MAX_ACCURACY_METERS) || 50;
const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || 'Asia/Kolkata';

// Helper to get protocol and host cleanly (supporting HTTPS behind Vercel/proxies)
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// Fallback user avatar SVG (served when an attendance image is missing or cannot be loaded)
const FALLBACK_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="10" fill="#e2e8f0"/>
  <circle cx="50" cy="40" r="20" fill="#94a3b8"/>
  <path d="M20 85 C20 68 35 65 50 65 C65 65 80 68 80 85 Z" fill="#94a3b8"/>
</svg>`;

// Helper to ensure public/uploads directory exists (safe for Vercel read-only FS)
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (e) {
  // Ignored on read-only environments like Vercel
}

// Haversine formula: Calculate distance in meters between two GPS coordinates
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) {
    return Infinity;
  }
  const R = 6371e3; // Earth radius in metres
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c); // Distance in meters
}

// Check if coordinates or address fall within the office boundary or NX One commercial campus
function isInsideOfficeBoundary(lat, lng, address = '') {
  if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) return false;
  const dist = calculateDistanceMeters(lat, lng, OFFICE_LATITUDE, OFFICE_LONGITUDE);
  if (dist <= OFFICE_RADIUS_METERS) return true;

  // NX One Techzone 4 campus coordinates bounding box
  const isAtNXOne = (lat >= 28.5920 && lat <= 28.6080 && lng >= 77.4200 && lng <= 77.4400);
  if (isAtNXOne) return true;

  // Address check if reverse geocoded as NX One
  if (address && /nx\s*one|techzone\s*4|greater\s*noida\s*west/i.test(address)) {
    return true;
  }

  return false;
}

// Helpers for Indian Standard Time (Asia/Kolkata, UTC+5:30)
function formatCleanISTTime(dateOrStr) {
  if (!dateOrStr) return null;
  try {
    if (typeof dateOrStr === 'string' && /^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i.test(dateOrStr.trim())) {
      return dateOrStr.trim();
    }
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

function formatCleanISTDate(dateOrStr) {
  if (!dateOrStr) return null;
  try {
    const d = new Date(dateOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-IN', {
        timeZone: ATTENDANCE_TIMEZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    }
  } catch (e) {}
  return String(dateOrStr);
}

// Get Start and End of Current Day in Asia/Kolkata
function getISTDayRange(dateObj = new Date()) {
  try {
    // Formats date in YYYY-MM-DD format in Asia/Kolkata
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

// Check if current punch in time in Asia/Kolkata is after 10:05 AM (Cutoff for Half Day)
function checkIsHalfDay(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: ATTENDANCE_TIMEZONE,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    // After 10:05 AM: hour > 10, or (hour === 10 and minute > 5)
    return (h > 10) || (h === 10 && m > 5);
  } catch (e) {
    try {
      const timeStr = date.toLocaleTimeString('en-US', {
        timeZone: ATTENDANCE_TIMEZONE,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });
      const [h, m] = timeStr.split(':').map(Number);
      return (h > 10) || (h === 10 && m > 5);
    } catch (err) {
      return false;
    }
  }
}

// 0. Office Configuration API (GET /api/attendance/office-config)
router.get('/office-config', (req, res) => {
  res.json({
    success: true,
    officeLatitude: OFFICE_LATITUDE,
    officeLongitude: OFFICE_LONGITUDE,
    officeRadiusMeters: OFFICE_RADIUS_METERS,
    gpsMaxAccuracyMeters: GPS_MAX_ACCURACY_METERS,
    timezone: ATTENDANCE_TIMEZONE,
    halfDayCutoff: '10:05 AM'
  });
});

// 1. Submit Attendance API (POST - Punch In / Login Attendance)
router.post('/submit', async (req, res) => {
  try {
    const { empId, empName, password, location, selfie } = req.body;

    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({
        success: false,
        message: 'GPS location coordinates (Latitude and Longitude) are required.'
      });
    }

    if (!selfie) {
      return res.status(400).json({
        success: false,
        message: 'Selfie photo is required to mark attendance.'
      });
    }

    // Geofence & GPS Accuracy Validation
    const userLat = parseFloat(location.lat);
    const userLng = parseFloat(location.lng);
    const userAccuracy = parseFloat(location.accuracy) || 0;
    const userAddress = location.address || '';

    const isHome = req.body.isHomeLocation === true || req.body.workMode === 'Home' || location?.isHome === true;
    const isAtOffice = isInsideOfficeBoundary(userLat, userLng, userAddress);

    // Check GPS accuracy: Wi-Fi on laptops has ±150m-250m accuracy; if at office or home, allow up to 450m
    const allowedAccuracy = (isHome || isAtOffice) ? Math.max(GPS_MAX_ACCURACY_METERS, 450) : GPS_MAX_ACCURACY_METERS;
    if (userAccuracy > allowedAccuracy) {
      return res.status(400).json({
        success: false,
        message: `GPS accuracy low (±${Math.round(userAccuracy)}m). Please refresh GPS location in browser settings.`
      });
    }

    // Calculate distance from office
    const distanceMeters = calculateDistanceMeters(userLat, userLng, OFFICE_LATITUDE, OFFICE_LONGITUDE);
    if (!isHome && !isAtOffice && distanceMeters > OFFICE_RADIUS_METERS) {
      return res.status(403).json({
        success: false,
        outsideRadius: true,
        distanceMeters: distanceMeters,
        allowedRadiusMeters: OFFICE_RADIUS_METERS,
        message: `Punch In rejected! You are ${distanceMeters}m away from the office boundary. Punch In is allowed only within the office campus (${OFFICE_RADIUS_METERS}m).`
      });
    }

    let trimmedId = (empId && String(empId).trim() !== 'undefined' && String(empId).trim() !== 'null') 
      ? String(empId).trim() 
      : '';
    const cleanEmpName = (empName && String(empName).trim() !== 'undefined' && String(empName).trim() !== 'null')
      ? String(empName).trim()
      : '';

    // Flexible lookup in User collection
    let user = null;
    if (trimmedId) {
      try {
        user = await User.findOne({
          $or: [
            { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
            { name: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
            { email: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
          ]
        });
      } catch (e) {
        user = await User.findOne({ empId: trimmedId });
      }
    }

    if (!user && cleanEmpName && cleanEmpName !== 'Employee') {
      try {
        user = await User.findOne({
          $or: [
            { name: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } },
            { email: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } }
          ]
        });
      } catch (e) {}
    }

    // Resolve employee ID
    let finalEmpId = '';
    if (user && user.empId && user.empId !== 'undefined' && user.empId !== 'null') {
      finalEmpId = user.empId;
    } else if (trimmedId && trimmedId !== 'undefined' && !trimmedId.includes('@')) {
      finalEmpId = trimmedId;
    } else if (user && user.name) {
      finalEmpId = `EMP-${user.name.replace(/\s+/g, '').toUpperCase()}`;
    } else if (cleanEmpName && cleanEmpName !== 'Employee') {
      finalEmpId = `EMP-${cleanEmpName.replace(/\s+/g, '').toUpperCase()}`;
    } else {
      finalEmpId = 'EMP101';
    }

    let finalEmpName = user ? user.name : (cleanEmpName && cleanEmpName !== 'Employee' ? cleanEmpName : finalEmpId);

    if (user && (!user.empId || user.empId === 'undefined' || user.empId === 'null')) {
      try {
        await User.updateOne({ _id: user._id }, { $set: { empId: finalEmpId } });
      } catch (e) {}
    }

    // Password verification if provided
    if (password && user && user.password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Incorrect password! Please enter the correct password.'
        });
      }
    }

    // Check 10:05 AM Half Day Rule (supports testSimulatedTime during testing)
    let now = new Date();
    if (req.body.testSimulatedTime) {
      const customD = new Date(req.body.testSimulatedTime);
      if (!isNaN(customD.getTime())) {
        now = customD;
      }
    }
    const isHalfDay = checkIsHalfDay(now);
    const calculatedStatus = isHalfDay ? 'Half Day' : (req.body.status || 'Present');

    // Save base64 image as file if possible
    let imageRelativePath = '';
    if (selfie && selfie.startsWith('data:image')) {
      try {
        const filename = `selfie-${finalEmpId}-${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, base64Data, 'base64');
        imageRelativePath = `/uploads/${filename}`;
      } catch (err) {
        imageRelativePath = '';
      }
    }

    const loginTimeStr = formatCleanISTTime(now);

    const savedLocation = {
      address: location.address || 'Office Location',
      lat: userLat,
      lng: userLng,
      accuracy: userAccuracy,
      distanceMeters: distanceMeters
    };

    const record = new Attendance({
      empId: finalEmpId,
      empName: finalEmpName,
      status: calculatedStatus,
      isHalfDay: isHalfDay,
      location: savedLocation,
      selfie: selfie,
      imageUrl: imageRelativePath || '',
      punchIn: now,
      punchOut: null,
      loginTime: loginTimeStr,
      logoutTime: null
    });

    await record.save();

    const fullImageUrl = `/api/attendance/image/${record._id}`;

    const halfDayNotificationText = isHalfDay
      ? `Aap 10:05 AM ke baad login / punch kar rahe hain. Aapka Half Day lag gaya hai!`
      : null;

    const responseMsg = isHalfDay
      ? `Attendance marked as Half Day! (Punch In at ${loginTimeStr} - after 10:05 AM cutoff)`
      : `Attendance recorded successfully as Present for ${finalEmpName}!`;

    res.status(201).json({
      success: true,
      message: responseMsg,
      notificationMessage: halfDayNotificationText,
      halfDayNotification: halfDayNotificationText,
      status: calculatedStatus,
      isHalfDay: isHalfDay,
      distanceMeters: distanceMeters,
      empName: finalEmpName,
      empId: finalEmpId,
      loginTime: loginTimeStr,
      punchTime: loginTimeStr,
      logoutTime: null,
      imageUrl: fullImageUrl,
      data: {
        _id: record._id,
        empId: finalEmpId,
        empName: finalEmpName,
        status: calculatedStatus,
        isHalfDay: isHalfDay,
        loginTime: loginTimeStr,
        distanceMeters: distanceMeters,
        notificationMessage: halfDayNotificationText
      }
    });
  } catch (error) {
    console.error('Error saving attendance:', error);
    res.status(500).json({ success: false, message: 'Server error saving attendance.' });
  }
});

// 2. Punch Out API (POST /api/attendance/punch-out) - Requires Selfie & Geofence
router.post('/punch-out', async (req, res) => {
  try {
    const empInput = req.body?.empId || req.body?.employeeId || req.body?.email || req.body?.empName || req.body?.name;
    const cleanEmpName = req.body?.empName || req.body?.name || '';
    const location = req.body?.location || null;
    const selfie = req.body?.selfie || null;
    const isLunch = req.body?.isLunch === true || req.body?.breakType === 'Lunch' || req.body?.lunchMode === true || req.body?.action === 'lunch';

    // Selfie is mandatory for regular punch out, but BYPASSED if lunch is active
    if (!isLunch && !selfie) {
      return res.status(400).json({
        success: false,
        message: 'Punch Out karne ke liye selfie photo zaroori hai!'
      });
    }

    if (!location || !location.lat || !location.lng) {
      if (!isLunch) {
        return res.status(400).json({
          success: false,
          message: 'GPS location coordinates are required for Punch Out.'
        });
      }
    }

    const userLat = location && location.lat !== undefined ? parseFloat(location.lat) : OFFICE_LATITUDE;
    const userLng = location && location.lng !== undefined ? parseFloat(location.lng) : OFFICE_LONGITUDE;
    const userAccuracy = location && location.accuracy !== undefined ? parseFloat(location.accuracy) || 0 : 15;

    const isHome = req.body?.isHomeLocation === true || req.body?.workMode === 'Home' || location?.isHome === true;

    // Check GPS accuracy (Only enforced for Office Mode without Lunch; bypassed when Home Mode or Lunch is active)
    if (!isHome && !isLunch && userAccuracy > GPS_MAX_ACCURACY_METERS) {
      return res.status(400).json({
        success: false,
        message: `GPS accuracy low (±${Math.round(userAccuracy)}m). Maximum allowed accuracy for office is ±${GPS_MAX_ACCURACY_METERS}m. Please ensure GPS is enabled.`
      });
    }

    // Daily Work & Development Report Validation (Bypassed when lunch is active)
    const workCategory = req.body?.workCategory || (isLunch ? 'Lunch Break' : 'Development & Code Changes');
    const workReport = (req.body?.workReport || req.body?.report || req.body?.dailyReport || req.body?.workSummary || (isLunch ? 'Lunch break taken' : '')).trim();
    const developmentChanges = (req.body?.developmentChanges || req.body?.changes || '').trim();
    const taskSummary = (req.body?.taskSummary || (isLunch ? 'Lunch break' : '')).trim();

    if (!isLunch && (!workReport || workReport.length < 5)) {
      return res.status(400).json({
        success: false,
        requiresReport: true,
        message: 'Daily Work & Development Report is required. Please describe your tasks and development changes before Punch Out.'
      });
    }

    // Geofence check for Punch Out (bypassed if isHome or isLunch)
    const isAtOfficeOut = isInsideOfficeBoundary(userLat, userLng, location?.address || '');
    const distanceMeters = calculateDistanceMeters(userLat, userLng, OFFICE_LATITUDE, OFFICE_LONGITUDE);
    if (!isHome && !isLunch && !isAtOfficeOut && distanceMeters > OFFICE_RADIUS_METERS) {
      return res.status(403).json({
        success: false,
        outsideRadius: true,
        distanceMeters: distanceMeters,
        allowedRadiusMeters: OFFICE_RADIUS_METERS,
        message: `Punch Out rejected! You are ${distanceMeters}m away from the office boundary. Punch Out is allowed only within ${OFFICE_RADIUS_METERS}m of the office campus.`
      });
    }

    let trimmedId = (empInput && String(empInput).trim() !== 'undefined' && String(empInput).trim() !== 'null') 
      ? String(empInput).trim() 
      : '';

    // Check token if still no ID
    if (!trimmedId && req.headers.authorization) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.decode(token);
        if (decoded && decoded.empId) trimmedId = decoded.empId;
      } catch (e) {}
    }

    // Look up user to resolve ID and Name
    let user = null;
    if (trimmedId) {
      user = await User.findOne({
        $or: [
          { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
          { name: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
          { email: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
        ]
      });
    }
    if (!user && cleanEmpName) {
      user = await User.findOne({ name: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } });
    }

    const searchEmpId = (user && user.empId && user.empId !== 'undefined') ? user.empId : trimmedId;
    const searchName = user ? user.name : cleanEmpName;

    const orConditions = [];
    if (searchEmpId) {
      orConditions.push({ empId: { $regex: new RegExp(`^${searchEmpId}$`, 'i') } });
    }
    if (searchName) {
      orConditions.push({ empName: { $regex: new RegExp(`^${searchName}$`, 'i') } });
    }
    if (trimmedId && trimmedId !== searchEmpId && trimmedId !== searchName) {
      orConditions.push({ empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } });
      orConditions.push({ empName: { $regex: new RegExp(`^${trimmedId}$`, 'i') } });
    }

    // Find latest open record (punchOut is null)
    let record = null;
    if (orConditions.length > 0) {
      record = await Attendance.findOne({
        $or: orConditions,
        punchOut: null
      }).sort({ createdAt: -1 });

      if (!record) {
        record = await Attendance.findOne({
          $or: orConditions
        }).sort({ createdAt: -1 });
      }
    } else {
      record = await Attendance.findOne({ punchOut: null }).sort({ createdAt: -1 });
    }

    let now = new Date();
    if (req.body.testSimulatedTime) {
      const customD = new Date(req.body.testSimulatedTime);
      if (!isNaN(customD.getTime())) now = customD;
    }
    const logoutTimeStr = formatCleanISTTime(now);

    // Save punch out selfie to file if possible
    let punchOutImgRelative = '';
    if (selfie && selfie.startsWith('data:image')) {
      try {
        const filename = `selfie-out-${searchEmpId || 'EMP'}-${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, base64Data, 'base64');
        punchOutImgRelative = `/uploads/${filename}`;
      } catch (err) {
        punchOutImgRelative = '';
      }
    }

    const savedLogoutLocation = {
      address: location.address || 'Office Location',
      lat: userLat,
      lng: userLng,
      accuracy: userAccuracy,
      distanceMeters: distanceMeters
    };

    const userOrgId = req.body?.organizationId || (user && user.organizationId) || 'org_advmen_platform';

    if (!record) {
      const finalId = searchEmpId || (searchName ? `EMP-${searchName.toUpperCase()}` : 'EMP101');
      const finalName = searchName || 'Employee';
      record = new Attendance({
        empId: finalId,
        empName: finalName,
        organizationId: userOrgId,
        status: 'Present',
        location: savedLogoutLocation,
        punchIn: now,
        punchOut: now,
        loginTime: logoutTimeStr,
        logoutTime: logoutTimeStr,
        logoutLocation: savedLogoutLocation,
        punchOutSelfie: selfie,
        punchOutImageUrl: punchOutImgRelative || '',
        workCategory: workCategory,
        workReport: workReport,
        developmentChanges: developmentChanges,
        taskSummary: taskSummary,
        reportSubmittedAt: now
      });
      await record.save();
    } else {
      record.punchOut = now;
      record.logoutTime = logoutTimeStr;
      record.logoutLocation = savedLogoutLocation;
      record.punchOutSelfie = selfie;
      record.punchOutImageUrl = punchOutImgRelative || '';
      record.workCategory = workCategory;
      record.workReport = workReport;
      record.developmentChanges = developmentChanges;
      record.taskSummary = taskSummary;
      record.reportSubmittedAt = now;
      if (userOrgId) record.organizationId = userOrgId;
      if (isLunch) {
        record.isOnLunch = true;
        record.lunchStartTime = now;
        if (!record.lunchBreaks) record.lunchBreaks = [];
        record.lunchBreaks.push({
          startTime: now,
          endTime: null,
          durationMinutes: 0,
          startStr: logoutTimeStr,
          endStr: '',
          durationStr: 'In Progress',
          notes: 'Lunch Break'
        });
      }
      await record.save();
    }

    // Save report data into dedicated Report collection (only when not just a lunch break without real report)
    if (!isLunch || (workReport && workReport.length >= 5)) {
      try {
        await Report.findOneAndUpdate(
          { attendanceId: record._id },
          {
            $set: {
              empId: record.empId,
              empName: record.empName,
              organizationId: record.organizationId || 'org_advmen_platform',
              workCategory: record.workCategory,
              workReport: record.workReport,
              developmentChanges: record.developmentChanges || '',
              taskSummary: record.taskSummary || '',
              attendanceId: record._id,
              date: formatCleanISTDate(now) || new Date().toISOString().slice(0, 10),
              punchInTime: record.loginTime || formatCleanISTTime(record.punchIn),
              punchOutTime: logoutTimeStr,
              workMode: req.body.workMode || (isHome ? 'Home' : 'Office'),
              location: savedLogoutLocation,
              status: 'Submitted',
              submittedAt: now
            }
          },
          { upsert: true, new: true }
        );
      } catch (repErr) {
        console.error('Error saving to reports collection:', repErr.message);
      }
    }

    const inTime = record.loginTime || formatCleanISTTime(record.punchIn);
    const successMsg = isLunch
      ? `Lunch break recorded successfully at ${logoutTimeStr} for ${record.empName}! (Report & selfie bypassed)`
      : `Punch Out recorded successfully for ${record.empName}! Work & Development report saved.`;

    res.status(200).json({
      success: true,
      message: successMsg,
      empId: record.empId,
      empName: record.empName,
      isLunch: isLunch,
      isOnLunch: Boolean(record.isOnLunch),
      lunchStartTime: isLunch ? logoutTimeStr : null,
      loginTime: inTime,
      punchTime: inTime,
      logoutTime: logoutTimeStr,
      punchOutTime: logoutTimeStr,
      workCategory: record.workCategory,
      workReport: record.workReport,
      developmentChanges: record.developmentChanges,
      reportSubmittedAt: formatCleanISTTime(record.reportSubmittedAt || now),
      distanceMeters: distanceMeters
    });
  } catch (err) {
    console.error('Error during punch out:', err);
    res.status(500).json({ success: false, message: 'Server error during punch out.', error: err.message });
  }
});

// =========================================================================
// DEDICATED LUNCH BREAK APIS (NO SELFIE & NO WORK REPORT REQUIRED)
// =========================================================================

// Helper to find today's active attendance record for an employee
async function findTodayAttendanceRecord(empId, empName) {
  const { startOfDay, endOfDay } = getISTDayRange();
  const trimmedId = empId ? String(empId).trim() : '';
  const cleanName = empName ? String(empName).trim() : '';

  const orConditions = [];
  if (trimmedId) {
    orConditions.push({ empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } });
  }
  if (cleanName) {
    orConditions.push({ empName: { $regex: new RegExp(`^${cleanName}$`, 'i') } });
  }

  if (orConditions.length === 0) return null;

  let record = await Attendance.findOne({
    $or: orConditions,
    createdAt: { $gte: startOfDay, $lte: endOfDay }
  }).sort({ createdAt: -1 });

  if (!record) {
    record = await Attendance.findOne({
      $or: orConditions
    }).sort({ createdAt: -1 });
  }

  return record;
}

// 1. Start Lunch Break (POST /api/attendance/lunch/start)
// NO SELFIE AND NO WORK REPORT REQUIRED!
router.post(['/lunch/start', '/lunch-start'], async (req, res) => {
  try {
    const empInput = req.body?.empId || req.body?.employeeId || req.body?.email || req.body?.empName || req.body?.name;
    const cleanEmpName = req.body?.empName || req.body?.name || '';
    const location = req.body?.location || null;

    if (!empInput && !cleanEmpName) {
      return res.status(400).json({ success: false, message: 'Employee ID or Name is required for Lunch Break.' });
    }

    let record = await findTodayAttendanceRecord(empInput, cleanEmpName);
    const now = new Date();
    const timeStr = formatCleanISTTime(now);

    if (!record) {
      const finalId = empInput || (cleanEmpName ? `EMP-${cleanEmpName.toUpperCase()}` : 'EMP101');
      const finalName = cleanEmpName || finalId;
      record = new Attendance({
        empId: finalId,
        empName: finalName,
        status: 'Present',
        punchIn: now,
        loginTime: timeStr,
        location: location || { address: 'Office Location', lat: OFFICE_LATITUDE, lng: OFFICE_LONGITUDE },
        isOnLunch: true,
        lunchStartTime: now,
        lunchBreaks: [{
          startTime: now,
          endTime: null,
          durationMinutes: 0,
          startStr: timeStr,
          endStr: '',
          durationStr: 'In Progress',
          notes: req.body?.notes || 'Lunch Break'
        }]
      });
      await record.save();
    } else {
      record.isOnLunch = true;
      record.lunchStartTime = now;
      if (!record.lunchBreaks) record.lunchBreaks = [];
      record.lunchBreaks.push({
        startTime: now,
        endTime: null,
        durationMinutes: 0,
        startStr: timeStr,
        endStr: '',
        durationStr: 'In Progress',
        notes: req.body?.notes || 'Lunch Break'
      });
      await record.save();
    }

    res.status(200).json({
      success: true,
      isOnLunch: true,
      empId: record.empId,
      empName: record.empName,
      lunchStartTime: timeStr,
      message: `Lunch break started at ${timeStr}! Report aur selfie submit karne ki zaroorat nahi hai.`,
      data: {
        empId: record.empId,
        empName: record.empName,
        isOnLunch: true,
        lunchStartTime: timeStr,
        lunchBreaks: record.lunchBreaks
      }
    });
  } catch (err) {
    console.error('Error starting lunch:', err);
    res.status(500).json({ success: false, message: 'Server error starting lunch.', error: err.message });
  }
});

// 2. End Lunch Break (POST /api/attendance/lunch/end)
// NO SELFIE AND NO WORK REPORT REQUIRED!
router.post(['/lunch/end', '/lunch-end'], async (req, res) => {
  try {
    const empInput = req.body?.empId || req.body?.employeeId || req.body?.email || req.body?.empName || req.body?.name;
    const cleanEmpName = req.body?.empName || req.body?.name || '';

    if (!empInput && !cleanEmpName) {
      return res.status(400).json({ success: false, message: 'Employee ID or Name is required.' });
    }

    let record = await findTodayAttendanceRecord(empInput, cleanEmpName);
    if (!record) {
      return res.status(404).json({ success: false, message: 'No active attendance record found for today.' });
    }

    const now = new Date();
    const timeStr = formatCleanISTTime(now);

    record.isOnLunch = false;
    record.lunchEndTime = now;

    let breakDuration = 0;
    if (record.lunchBreaks && record.lunchBreaks.length > 0) {
      const openBreak = [...record.lunchBreaks].reverse().find(b => !b.endTime);
      if (openBreak) {
        openBreak.endTime = now;
        openBreak.endStr = timeStr;
        const diffMs = Math.max(0, now.getTime() - new Date(openBreak.startTime).getTime());
        breakDuration = Math.round(diffMs / 60000);
        openBreak.durationMinutes = breakDuration;
        openBreak.durationStr = `${breakDuration} mins`;
      }
    }

    const totalMinutes = (record.lunchBreaks || []).reduce((sum, b) => sum + (b.durationMinutes || 0), 0);
    record.lunchDuration = totalMinutes;
    record.lunchDurationFormatted = `${totalMinutes} mins`;

    await record.save();

    res.status(200).json({
      success: true,
      isOnLunch: false,
      empId: record.empId,
      empName: record.empName,
      lunchEndTime: timeStr,
      breakDurationMinutes: breakDuration,
      totalLunchMinutes: totalMinutes,
      totalLunchDurationFormatted: record.lunchDurationFormatted,
      message: `Lunch break ended at ${timeStr} (${breakDuration} mins)! Welcome back to work.`,
      data: {
        empId: record.empId,
        empName: record.empName,
        isOnLunch: false,
        lunchEndTime: timeStr,
        breakDurationMinutes: breakDuration,
        totalLunchMinutes: totalMinutes,
        lunchBreaks: record.lunchBreaks
      }
    });
  } catch (err) {
    console.error('Error ending lunch:', err);
    res.status(500).json({ success: false, message: 'Server error ending lunch.', error: err.message });
  }
});

// 3. Toggle Lunch Break (POST /api/attendance/lunch/toggle or POST /api/attendance/lunch)
router.post(['/lunch/toggle', '/lunch'], async (req, res) => {
  try {
    const empInput = req.body?.empId || req.body?.employeeId || req.body?.email || req.body?.empName || req.body?.name;
    const cleanEmpName = req.body?.empName || req.body?.name || '';
    const action = req.body?.action; // 'start', 'end', or toggle

    const record = await findTodayAttendanceRecord(empInput, cleanEmpName);
    const isCurrentlyOnLunch = record ? Boolean(record.isOnLunch) : false;

    if (action === 'start' || (!action && !isCurrentlyOnLunch)) {
      // Start lunch
      const now = new Date();
      const timeStr = formatCleanISTTime(now);

      if (!record) {
        const finalId = empInput || (cleanEmpName ? `EMP-${cleanEmpName.toUpperCase()}` : 'EMP101');
        const finalName = cleanEmpName || finalId;
        const newRecord = new Attendance({
          empId: finalId,
          empName: finalName,
          status: 'Present',
          punchIn: now,
          loginTime: timeStr,
          location: req.body?.location || { address: 'Office Location', lat: OFFICE_LATITUDE, lng: OFFICE_LONGITUDE },
          isOnLunch: true,
          lunchStartTime: now,
          lunchBreaks: [{
            startTime: now,
            endTime: null,
            durationMinutes: 0,
            startStr: timeStr,
            endStr: '',
            durationStr: 'In Progress',
            notes: 'Lunch Break'
          }]
        });
        await newRecord.save();
        return res.status(200).json({
          success: true,
          isOnLunch: true,
          empId: finalId,
          empName: finalName,
          lunchStartTime: timeStr,
          message: `Lunch break started at ${timeStr}! Report aur selfie submit karne ki zaroorat nahi hai.`,
          data: { isOnLunch: true, lunchStartTime: timeStr }
        });
      }

      record.isOnLunch = true;
      record.lunchStartTime = now;
      if (!record.lunchBreaks) record.lunchBreaks = [];
      record.lunchBreaks.push({
        startTime: now,
        endTime: null,
        durationMinutes: 0,
        startStr: timeStr,
        endStr: '',
        durationStr: 'In Progress',
        notes: 'Lunch Break'
      });
      await record.save();

      return res.status(200).json({
        success: true,
        isOnLunch: true,
        empId: record.empId,
        empName: record.empName,
        lunchStartTime: timeStr,
        message: `Lunch break started at ${timeStr}! Report aur selfie submit karne ki zaroorat nahi hai.`,
        data: { isOnLunch: true, lunchStartTime: timeStr, lunchBreaks: record.lunchBreaks }
      });
    } else {
      // End lunch
      if (!record) {
        return res.status(404).json({ success: false, message: 'No active attendance record found.' });
      }

      const now = new Date();
      const timeStr = formatCleanISTTime(now);
      record.isOnLunch = false;
      record.lunchEndTime = now;

      let breakDuration = 0;
      if (record.lunchBreaks && record.lunchBreaks.length > 0) {
        const openBreak = [...record.lunchBreaks].reverse().find(b => !b.endTime);
        if (openBreak) {
          openBreak.endTime = now;
          openBreak.endStr = timeStr;
          const diffMs = Math.max(0, now.getTime() - new Date(openBreak.startTime).getTime());
          breakDuration = Math.round(diffMs / 60000);
          openBreak.durationMinutes = breakDuration;
          openBreak.durationStr = `${breakDuration} mins`;
        }
      }

      const totalMinutes = (record.lunchBreaks || []).reduce((sum, b) => sum + (b.durationMinutes || 0), 0);
      record.lunchDuration = totalMinutes;
      record.lunchDurationFormatted = `${totalMinutes} mins`;
      await record.save();

      return res.status(200).json({
        success: true,
        isOnLunch: false,
        empId: record.empId,
        empName: record.empName,
        lunchEndTime: timeStr,
        breakDurationMinutes: breakDuration,
        totalLunchMinutes: totalMinutes,
        totalLunchDurationFormatted: record.lunchDurationFormatted,
        message: `Lunch break ended at ${timeStr} (${breakDuration} mins)! Welcome back to work.`,
        data: { isOnLunch: false, lunchEndTime: timeStr, breakDurationMinutes: breakDuration, totalLunchMinutes: totalMinutes }
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error toggling lunch state.', error: err.message });
  }
});

// 4. Get Lunch Status (GET /api/attendance/lunch/status/:empId or GET /api/attendance/lunch-status)
router.get(['/lunch/status/:empId', '/lunch-status'], async (req, res) => {
  try {
    const empId = req.params?.empId || req.query?.empId || req.query?.employeeId;
    const name = req.query?.name || req.query?.empName;
    const record = await findTodayAttendanceRecord(empId, name);

    if (!record) {
      return res.status(200).json({
        success: true,
        empId: empId || '',
        isOnLunch: false,
        lunchStartTime: null,
        lunchEndTime: null,
        lunchDuration: 0,
        lunchDurationFormatted: '0 mins',
        lunchBreaks: []
      });
    }

    const openBreak = (record.lunchBreaks || []).find(b => !b.endTime);

    res.status(200).json({
      success: true,
      empId: record.empId,
      empName: record.empName,
      isOnLunch: Boolean(record.isOnLunch),
      currentBreak: openBreak || null,
      lunchStartTime: record.lunchStartTime ? formatCleanISTTime(record.lunchStartTime) : null,
      lunchEndTime: record.lunchEndTime ? formatCleanISTTime(record.lunchEndTime) : null,
      lunchDuration: record.lunchDuration || 0,
      lunchDurationFormatted: record.lunchDurationFormatted || `${record.lunchDuration || 0} mins`,
      lunchBreaks: record.lunchBreaks || []
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching lunch status.', error: err.message });
  }
});

// 5. Query All Lunch Records (GET /api/attendance/lunch-records or /api/attendance/lunch/all)
router.get(['/lunch-records', '/lunch/all'], async (req, res) => {
  try {
    const { date, empId } = req.query;
    let mongoFilter = {};

    if (date) {
      const searchDate = new Date(date);
      const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
      mongoFilter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    } else {
      const { startOfDay, endOfDay } = getISTDayRange();
      mongoFilter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    if (empId) {
      mongoFilter.$or = [{ empId: empId.trim() }, { empId: empId.trim().toUpperCase() }];
    }

    const records = await Attendance.find(mongoFilter)
      .select('-selfie -punchOutSelfie')
      .sort({ createdAt: -1 })
      .lean();

    const lunchData = records.map(r => ({
      recordId: r._id,
      empId: r.empId,
      empName: r.empName,
      date: formatCleanISTDate(r.punchIn || r.createdAt),
      punchInTime: formatCleanISTTime(r.punchIn || r.loginTime),
      punchOutTime: (r.punchOut || r.logoutTime) ? formatCleanISTTime(r.punchOut || r.logoutTime) : null,
      isOnLunch: Boolean(r.isOnLunch),
      lunchStartTime: r.lunchStartTime ? formatCleanISTTime(r.lunchStartTime) : null,
      lunchEndTime: r.lunchEndTime ? formatCleanISTTime(r.lunchEndTime) : null,
      lunchDuration: r.lunchDuration || 0,
      lunchDurationFormatted: r.lunchDurationFormatted || (r.lunchDuration ? `${r.lunchDuration} mins` : '0 mins'),
      lunchBreaks: (r.lunchBreaks || []).map(b => ({
        startTime: b.startTime,
        endTime: b.endTime,
        durationMinutes: b.durationMinutes || 0,
        startStr: b.startStr || formatCleanISTTime(b.startTime),
        endStr: b.endStr || (b.endTime ? formatCleanISTTime(b.endTime) : ''),
        durationStr: b.durationStr || (b.durationMinutes ? `${b.durationMinutes} mins` : (b.endTime ? '0 mins' : 'In Progress')),
        notes: b.notes || 'Lunch Break'
      }))
    }));

    const currentlyOnLunchCount = lunchData.filter(x => x.isOnLunch).length;
    const totalLunchTakenCount = lunchData.filter(x => x.lunchDuration > 0 || (x.lunchBreaks && x.lunchBreaks.length > 0)).length;

    res.status(200).json({
      success: true,
      totalRecords: lunchData.length,
      currentlyOnLunchCount,
      totalLunchTakenCount,
      data: lunchData
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching lunch records.', error: err.message });
  }
});

// Dedicated Daily Work Report Submission API (POST /api/attendance/work-report)
router.post('/work-report', async (req, res) => {
  try {
    const { empId, empName, workReport, workCategory, developmentChanges, taskSummary } = req.body;
    if (!workReport || workReport.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Daily work report must have at least 5 characters.'
      });
    }

    const cleanReport = workReport.trim();
    const now = new Date();

    const searchEmpId = empId ? String(empId).trim() : '';
    const searchName = empName ? String(empName).trim() : '';

    const orConds = [];
    if (searchEmpId) orConds.push({ empId: searchEmpId });
    if (searchName) orConds.push({ empName: searchName });

    let record = null;
    if (orConds.length > 0) {
      record = await Attendance.findOne({ $or: orConds }).sort({ createdAt: -1 });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'No active attendance record found for today. Please punch in first.'
      });
    }

    record.workReport = cleanReport;
    if (workCategory) record.workCategory = workCategory;
    if (developmentChanges) record.developmentChanges = developmentChanges.trim();
    if (taskSummary) record.taskSummary = taskSummary.trim();
    record.reportSubmittedAt = now;
    await record.save();

    // Save or update in dedicated Report collection
    try {
      await Report.findOneAndUpdate(
        { attendanceId: record._id },
        {
          $set: {
            empId: record.empId,
            empName: record.empName,
            organizationId: record.organizationId || 'org_advmen_platform',
            workCategory: record.workCategory,
            workReport: cleanReport,
            developmentChanges: record.developmentChanges || '',
            taskSummary: record.taskSummary || '',
            attendanceId: record._id,
            date: formatCleanISTDate(now) || new Date().toISOString().slice(0, 10),
            punchInTime: record.loginTime,
            punchOutTime: record.logoutTime,
            workMode: record.location?.isHome ? 'Home' : 'Office',
            location: record.location || {},
            status: 'Submitted',
            submittedAt: now
          }
        },
        { upsert: true, new: true }
      );
    } catch (repErr) {
      console.error('Error saving to reports collection in /work-report:', repErr.message);
    }

    res.status(200).json({
      success: true,
      collection: 'reports',
      message: 'Daily Work & Development Report saved successfully in reports collection!',
      workCategory: record.workCategory,
      workReport: cleanReport,
      developmentChanges: record.developmentChanges,
      reportSubmittedAt: formatCleanISTTime(now)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error submitting work report.', error: err.message });
  }
});

// =========================================================================
// REPORTS & SUPER ADMIN CRM ENDPOINTS: FULL WORK & DEVELOPMENT DATA
// =========================================================================

// All Reports API (GET /api/attendance/reports or /api/attendance/super-admin/reports)
router.get(['/reports', '/super-admin/reports'], async (req, res) => {
  try {
    const { date, month, empId, category, search, limit } = req.query;
    const mongoFilter = {};

    if (empId) {
      const trimmed = empId.trim();
      mongoFilter.$or = [
        { empId: trimmed },
        { empId: trimmed.toUpperCase() }
      ];
    }

    if (category) {
      mongoFilter.workCategory = new RegExp(category.trim(), 'i');
    }

    // Specific date or month filter
    if (date) {
      const searchDate = new Date(date);
      const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
      mongoFilter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    } else if (month) {
      const [yearNum, monthNum] = month.split('-').map(Number);
      const startOfMonth = new Date(yearNum, monthNum - 1, 1, 0, 0, 0);
      const endOfMonth = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
      mongoFilter.createdAt = { $gte: startOfMonth, $lte: endOfMonth };
    }

    // Query dedicated Report collection
    let reports = await Report.find(mongoFilter).sort({ createdAt: -1 }).lean();

    // Auto-sync any legacy Attendance records with workReport into Report collection if needed
    const attWithReports = await Attendance.find({
      ...mongoFilter,
      workReport: { $exists: true, $ne: '' }
    }).select('-selfie -punchOutSelfie').sort({ createdAt: -1 }).lean();

    if (attWithReports.length > reports.length) {
      for (const att of attWithReports) {
        try {
          await Report.findOneAndUpdate(
            { attendanceId: att._id },
            {
              $set: {
                empId: att.empId,
                empName: att.empName,
                organizationId: att.organizationId || 'org_advmen_platform',
                workCategory: att.workCategory || 'Development & Code Changes',
                workReport: att.workReport,
                developmentChanges: att.developmentChanges || '',
                taskSummary: att.taskSummary || '',
                attendanceId: att._id,
                date: formatCleanISTDate(att.punchIn || att.createdAt) || new Date(att.createdAt).toISOString().slice(0, 10),
                punchInTime: att.loginTime,
                punchOutTime: att.logoutTime,
                workMode: att.location?.isHome ? 'Home' : 'Office',
                location: att.logoutLocation || att.location || {},
                status: 'Submitted',
                submittedAt: att.reportSubmittedAt || att.createdAt,
                createdAt: att.createdAt
              }
            },
            { upsert: true }
          );
        } catch (syncErr) {}
      }
      reports = await Report.find(mongoFilter).sort({ createdAt: -1 }).lean();
    }

    if (search) {
      const q = search.trim().toLowerCase();
      reports = reports.filter(r => 
        (r.empName && r.empName.toLowerCase().includes(q)) ||
        (r.empId && r.empId.toLowerCase().includes(q)) ||
        (r.workReport && r.workReport.toLowerCase().includes(q)) ||
        (r.developmentChanges && r.developmentChanges.toLowerCase().includes(q)) ||
        (r.workCategory && r.workCategory.toLowerCase().includes(q))
      );
    }

    res.status(200).json({
      success: true,
      collection: 'reports',
      total: reports.length,
      reportsCount: reports.length,
      data: reports
    });
  } catch (err) {
    console.error('Super Admin reports error:', err);
    res.status(500).json({ success: false, message: 'Server error retrieving Super Admin reports.', error: err.message });
  }
});

// Super Admin Summary Stats API (GET /api/attendance/super-admin/summary)
router.get('/super-admin/summary', async (req, res) => {
  try {
    const { startOfDay, endOfDay } = getISTDayRange();
    const todayReports = await Report.find({ createdAt: { $gte: startOfDay, $lte: endOfDay } }).lean();
    const todayAttendances = await Attendance.find({ createdAt: { $gte: startOfDay, $lte: endOfDay } })
      .select('-selfie -punchOutSelfie')
      .lean();

    const formattedAtt = formatAttendanceRecords(todayAttendances);
    const uniqueEmployees = new Set(formattedAtt.map(r => r.empId)).size;
    const devChanges = todayReports.filter(r => r.developmentChanges && r.developmentChanges.length > 0);
    const halfDays = formattedAtt.filter(r => r.isHalfDay);

    res.status(200).json({
      success: true,
      collection: 'reports',
      summary: {
        totalPunchedInToday: formattedAtt.length,
        uniqueEmployeesToday: uniqueEmployees,
        reportsSubmittedCount: todayReports.length,
        reportsPendingCount: Math.max(0, formattedAtt.length - todayReports.length),
        developmentChangesCount: devChanges.length,
        halfDayCount: halfDays.length
      },
      reports: todayReports
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error calculating summary.', error: err.message });
  }
});

// Single Employee Full Report API (GET /api/attendance/report/:empId)
router.get('/report/:empId', async (req, res) => {
  try {
    const { empId } = req.params;
    const { date } = req.query;

    const filter = {
      $or: [
        { empId: empId.trim() },
        { empId: empId.trim().toUpperCase() }
      ]
    };

    if (date) {
      const searchDate = new Date(date);
      const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
      filter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    let report = await Report.findOne(filter).sort({ createdAt: -1 }).lean();

    if (!report) {
      const attRecord = await Attendance.findOne({
        ...filter,
        workReport: { $exists: true, $ne: '' }
      }).select('-selfie -punchOutSelfie').sort({ createdAt: -1 }).lean();

      if (attRecord) {
        report = {
          empId: attRecord.empId,
          empName: attRecord.empName,
          organizationId: attRecord.organizationId,
          workCategory: attRecord.workCategory,
          workReport: attRecord.workReport,
          developmentChanges: attRecord.developmentChanges,
          attendanceId: attRecord._id,
          punchInTime: attRecord.loginTime,
          punchOutTime: attRecord.logoutTime,
          submittedAt: attRecord.reportSubmittedAt || attRecord.createdAt,
          createdAt: attRecord.createdAt
        };
      }
    }

    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'No report found in reports collection for this employee.'
      });
    }

    res.status(200).json({ success: true, collection: 'reports', data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error retrieving employee report.', error: err.message });
  }
});

// Alias for backwards compatibility
router.all('/logout', async (req, res) => {
  res.redirect(307, '/api/attendance/punch-out');
});

// 3. Serve Image by Attendance ID (GET /api/attendance/image/:id?type=out)
router.get('/image/:id', async (req, res) => {
  try {
    const isPunchOut = req.query.type === 'out';
    const record = await Attendance.findById(req.params.id);
    if (!record) {
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    const imgRef = isPunchOut
      ? (record.punchOutSelfie || record.punchOutImageUrl || record.selfie || record.imageUrl)
      : (record.selfie || record.imageUrl);

    if (!imgRef) {
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    // If it's a file saved on disk in public/uploads and exists
    if (typeof imgRef === 'string' && (imgRef.startsWith('/uploads/') || imgRef.startsWith('uploads/'))) {
      const filePath = path.join(__dirname, '..', 'public', imgRef.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    // External URL
    if (typeof imgRef === 'string' && (imgRef.startsWith('http://') || imgRef.startsWith('https://'))) {
      return res.redirect(imgRef);
    }

    // Base64 string in database
    if (typeof imgRef === 'string') {
      const matches = imgRef.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        res.set('Content-Type', mimeType);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      } else if (imgRef.length > 50 && !imgRef.startsWith('/')) {
        const cleanBase64 = imgRef.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    }

    res.set('Content-Type', 'image/svg+xml');
    return res.send(FALLBACK_AVATAR_SVG);
  } catch (err) {
    console.error('Error serving image:', err);
    res.set('Content-Type', 'image/svg+xml');
    res.send(FALLBACK_AVATAR_SVG);
  }
});

// Helper to project and format records for ultra-fast API delivery
function formatAttendanceRecords(records) {
  return records.map(r => {
    const createdAt = new Date(r.createdAt || r.punchIn || Date.now());
    const punchDateString = formatCleanISTDate(r.punchIn || r.createdAt);
    const punchOutDateString = r.punchOut ? formatCleanISTDate(r.punchOut) : null;
    const loginTimeString = formatCleanISTTime(r.punchIn || r.loginTime || r.createdAt);
    const logoutTimeString = (r.punchOut || r.logoutTime) ? formatCleanISTTime(r.punchOut || r.logoutTime) : null;

    const lat = r.location?.lat;
    const lng = r.location?.lng;
    const outLat = r.logoutLocation?.lat;
    const outLng = r.logoutLocation?.lng;

    return {
      recordId: r._id,
      _id: r._id,
      empId: r.empId || 'EMP101',
      empName: r.empName || 'Employee',
      status: r.status || (r.isHalfDay ? 'Half Day' : 'Present'),
      isHalfDay: !!r.isHalfDay || (r.status === 'Half Day'),
      punchDate: punchDateString,
      punchTime: loginTimeString,
      loginTime: loginTimeString,
      punchInTime: loginTimeString,
      logoutTime: logoutTimeString,
      punchOutTime: logoutTimeString,
      punchInDate: punchDateString,
      punchOutDate: punchOutDateString,
      timestamp: createdAt.toISOString(),
      punchIn: r.punchIn || r.createdAt,
      punchOut: r.punchOut || null,
      location: {
        address: r.location?.address || 'N/A',
        lat: lat,
        lng: lng,
        accuracy: r.location?.accuracy,
        distanceMeters: r.location?.distanceMeters,
        googleMapsUrl: (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null
      },
      logoutLocation: r.logoutLocation ? {
        address: r.logoutLocation.address || 'N/A',
        lat: outLat,
        lng: outLng,
        accuracy: r.logoutLocation.accuracy,
        distanceMeters: r.logoutLocation.distanceMeters,
        googleMapsUrl: (outLat && outLng) ? `https://www.google.com/maps?q=${outLat},${outLng}` : null
      } : null,
      imageUrl: `/api/attendance/image/${r._id}`,
      punchOutImageUrl: r.punchOut ? `/api/attendance/image/${r._id}?type=out` : null,
      organizationId: r.organizationId || 'org_advmen_platform',
      workCategory: r.workCategory || 'Development & Code Changes',
      workReport: r.workReport || '',
      developmentChanges: r.developmentChanges || '',
      taskSummary: r.taskSummary || '',
      reportSubmittedAt: r.reportSubmittedAt ? formatCleanISTTime(r.reportSubmittedAt) : null,
      isOnLunch: Boolean(r.isOnLunch),
      lunchStartTime: r.lunchStartTime ? formatCleanISTTime(r.lunchStartTime) : null,
      lunchEndTime: r.lunchEndTime ? formatCleanISTTime(r.lunchEndTime) : null,
      lunchDuration: r.lunchDuration || 0,
      lunchDurationFormatted: r.lunchDurationFormatted || (r.lunchDuration ? `${r.lunchDuration} mins` : ''),
      lunchBreaks: (r.lunchBreaks || []).map(b => ({
        startTime: b.startTime,
        endTime: b.endTime,
        durationMinutes: b.durationMinutes || 0,
        startStr: b.startStr || formatCleanISTTime(b.startTime),
        endStr: b.endStr || (b.endTime ? formatCleanISTTime(b.endTime) : ''),
        durationStr: b.durationStr || (b.durationMinutes ? `${b.durationMinutes} mins` : (b.endTime ? '0 mins' : 'In Progress')),
        notes: b.notes || 'Lunch Break'
      })),
      createdAt: r.createdAt
    };
  });
}

// 4. Fetch TODAY's Attendance API (GET /api/attendance/today) - ULTRA FAST & LIGHTWEIGHT
router.get('/today', async (req, res) => {
  try {
    const { startOfDay, endOfDay, istDateStr } = getISTDayRange();
    const { empId } = req.query;

    const filter = {
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    };

    if (empId) {
      filter.$or = [
        { empId: empId.trim() },
        { empId: empId.trim().toUpperCase() }
      ];
    }

    // Exclude large base64 selfie fields so the response is instant and small
    const records = await Attendance.find(filter)
      .select('-selfie -punchOutSelfie')
      .sort({ createdAt: -1 })
      .lean();

    const formattedData = formatAttendanceRecords(records);

    res.status(200).json({
      success: true,
      filter: 'today',
      date: istDateStr,
      totalRecords: formattedData.length,
      data: formattedData
    });
  } catch (error) {
    console.error('Error fetching today attendance:', error);
    res.status(500).json({ success: false, message: 'Server error fetching today records.', error: error.message });
  }
});

// 5. Fetch Attendance & Logs API (GET /api/attendance/all or /api/attendance/logs)
// Defaults to TODAY's records unless ?filter=all is explicitly requested
router.get(['/all', '/logs'], async (req, res) => {
  try {
    const { empId, date, limit, filter: reqFilter } = req.query;
    const mongoFilter = {};

    if (empId) {
      const trimmed = empId.trim();
      mongoFilter.$or = [
        { empId: trimmed },
        { empId: trimmed.toUpperCase() }
      ];
    }

    // If explicit date query passed
    if (date) {
      const searchDate = new Date(date);
      const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
      mongoFilter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    } else if (reqFilter !== 'all') {
      // By default, ONLY return TODAY's attendance records (as requested by user)
      const { startOfDay, endOfDay } = getISTDayRange();
      mongoFilter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    // Fast lean query excluding heavy base64 strings
    let query = Attendance.find(mongoFilter)
      .select('-selfie -punchOutSelfie')
      .sort({ createdAt: -1 })
      .lean();

    if (limit && !isNaN(parseInt(limit))) {
      query = query.limit(parseInt(limit));
    }

    const records = await query.exec();
    const formattedData = formatAttendanceRecords(records);

    res.status(200).json({
      success: true,
      totalRecords: formattedData.length,
      isTodayOnly: reqFilter !== 'all' && !date,
      data: formattedData
    });
  } catch (error) {
    console.error('Error fetching records:', error);
    res.status(500).json({ success: false, message: 'Server error fetching records.', error: error.message });
  }
});

// 6. Fetch All Employees Full Summary (GET /api/attendance/employees)
router.get('/employees', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 }).lean();
    const attendances = await Attendance.find()
      .select('-selfie -punchOutSelfie')
      .sort({ createdAt: -1 })
      .lean();

    const userByName = {};
    const userByEmpId = {};
    users.forEach(u => {
      if (u.name) userByName[u.name.toLowerCase().trim()] = u;
      if (u.empId && u.empId !== 'undefined') userByEmpId[u.empId.toLowerCase().trim()] = u;
    });

    const attendanceMap = {};
    attendances.forEach((att) => {
      let id = (att.empId || '').trim();
      if (!id || id === 'undefined' || id === 'null') {
        const u = userByName[(att.empName || '').toLowerCase().trim()];
        id = (u && u.empId && u.empId !== 'undefined') ? u.empId : (att.empName ? `EMP-${att.empName.toUpperCase()}` : 'EMP101');
      }

      if (!attendanceMap[id]) attendanceMap[id] = [];

      const cleanAtt = { ...att };
      cleanAtt.imageUrl = `/api/attendance/image/${att._id}`;
      cleanAtt.selfie = cleanAtt.imageUrl;
      cleanAtt.empId = id;
      cleanAtt.loginTime = formatCleanISTTime(cleanAtt.punchIn || cleanAtt.loginTime || cleanAtt.createdAt);
      cleanAtt.logoutTime = (cleanAtt.punchOut || cleanAtt.logoutTime) ? formatCleanISTTime(cleanAtt.punchOut || cleanAtt.logoutTime) : null;
      cleanAtt.punchTime = cleanAtt.loginTime;
      cleanAtt.punchInTime = cleanAtt.loginTime;
      cleanAtt.punchOutTime = cleanAtt.logoutTime;

      attendanceMap[id].push(cleanAtt);
    });

    const fullEmployeeData = [];
    const processedEmpIds = new Set();

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
    console.error('Error fetching employee summary:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;