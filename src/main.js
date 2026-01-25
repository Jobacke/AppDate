import './style.css';
import { initAuth } from './modules/auth.js';
import { initCalendar } from './modules/calendar.js';

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initCalendar();
});
