import React from 'react';
import { createRoot } from 'react-dom/client';
import MusGame from './MusGame.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MusGame />
  </React.StrictMode>
);
