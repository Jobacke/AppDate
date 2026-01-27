import './style.css';
import { initAuth } from './modules/auth.js';
import { initCalendar } from './modules/calendar.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log("AppDate Main Init - Build ID: " + Date.now());
  initAuth();
  initCalendar();
});
