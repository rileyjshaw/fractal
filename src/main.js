import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app.js';
import './style.css';

registerSW({ immediate: true });
startApp();
