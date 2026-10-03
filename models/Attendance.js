const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  empId: {
    type: String,
    required: true,
    trim: true
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
  location: {
    address: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number }
  },
  selfie: {
    type: String, // Base64 Image String or file path
    required: false
  },
  imageUrl: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Attendance', attendanceSchema);