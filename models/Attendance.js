const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  empId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  empName: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    default: 'Present'
  },
  isHalfDay: {
    type: Boolean,
    default: false
  },
  location: {
    address: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number },
    distanceMeters: { type: Number }
  },
  selfie: {
    type: String, // Base64 Image String or file path
    required: false
  },
  imageUrl: {
    type: String
  },
  punchIn: {
    type: Date,
    default: Date.now,
    index: true
  },
  punchOut: {
    type: Date,
    default: null
  },
  loginTime: {
    type: String
  },
  logoutTime: {
    type: String,
    default: null
  },
  logoutLocation: {
    address: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    accuracy: { type: Number },
    distanceMeters: { type: Number }
  },
  punchOutSelfie: {
    type: String,
    required: false
  },
  punchOutImageUrl: {
    type: String
  },
  organizationId: {
    type: String,
    default: 'org_advmen_platform',
    index: true
  },
  workReport: {
    type: String,
    trim: true,
    default: ''
  },
  workCategory: {
    type: String,
    default: 'Development'
  },
  developmentChanges: {
    type: String,
    trim: true,
    default: ''
  },
  taskSummary: {
    type: String,
    trim: true,
    default: ''
  },
  reportSubmittedAt: {
    type: Date,
    default: null
  },
  isOnLunch: {
    type: Boolean,
    default: false,
    index: true
  },
  lunchStartTime: {
    type: Date,
    default: null
  },
  lunchEndTime: {
    type: Date,
    default: null
  },
  lunchDuration: {
    type: Number,
    default: 0
  },
  lunchDurationFormatted: {
    type: String,
    default: ''
  },
  lunchBreaks: [
    {
      startTime: { type: Date, default: Date.now },
      endTime: { type: Date, default: null },
      durationMinutes: { type: Number, default: 0 },
      startStr: { type: String, default: '' },
      endStr: { type: String, default: '' },
      durationStr: { type: String, default: '' },
      notes: { type: String, default: 'Lunch Break' }
    }
  ],
  halfDayReason: {
    type: String,
    default: ''
  },
  halfDayNotificationSent: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

attendanceSchema.index({ createdAt: -1 });
attendanceSchema.index({ empId: 1, createdAt: -1 });

module.exports = mongoose.model('Attendance', attendanceSchema);