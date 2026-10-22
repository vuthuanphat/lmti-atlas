import { createRoot } from 'react-dom/client';
import { bootstrap } from './api';
import { App } from './App';
import './style.css';

// Consume the nonce once, outside React effects, including development double mounts.
const ready = bootstrap();
void ready.catch(() => undefined); // App renders the failure; avoid an early unhandled rejection.
createRoot(document.getElementById('root')!).render(<App ready={ready} />);
