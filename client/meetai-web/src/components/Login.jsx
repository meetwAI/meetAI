import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import createGlobe from 'cobe';
import './Login.css';
import { connectSocket } from '../api/socketClient';

const API_URL = 'http://localhost:4010';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const canvasRef = useRef(null);
  // Default: Israel (override once we get real location)
  const locationRef = useRef({ lat: 31.5, lng: 34.8 });
  const globeRef = useRef(null);
  const phiRef = useRef(0);
  const thetaRef = useRef(0);
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {

    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf;
    let lastUpdate = 0;
    const ROTATE_INTERVAL = 50; // ms
    const initGlobe = ({ lat, lng }) => {
      if (globeRef.current) {
        globeRef.current.destroy();
      }

      // cobe texture: phi=0 → prime meridian faces viewer.
      // To face longitude `lng`: rotate the globe so `lng` is in front.
      // cobe rotates the texture rightward as phi grows → to center `lng` we negate it.
      // Adding PI compensates for the texture's internal 180° offset.
      phiRef.current = Math.PI - (lng * Math.PI) / 180;
      thetaRef.current = -(lat * Math.PI) / 180 * 0.25; // smaller tilt

      globeRef.current = createGlobe(canvas, {
        devicePixelRatio: 0.7,          // Balanced GPU work
        width: 280,                     // 400 * 0.7 to prevent cropping
        height: 280,
        phi: phiRef.current,
        theta: thetaRef.current,
        dark: 1,
        diffuse: 1,
        mapSamples: 1500,              // Significantly reduced to save CPU power
        mapBrightness: 4,
        baseColor: [0.1, 0.18, 0.4],
        markerColor: [0.0, 0.9, 1.0],

        glowColor: [0.1, 0.3, 0.8],
        markers: [{ location: [lat, lng], size: 0.1 }],
        onRender: (state) => {
          const now = performance.now();
          if (!isDraggingRef.current && now - lastUpdate > ROTATE_INTERVAL) {
            phiRef.current += 0.01; // extremely slow rotation
            lastUpdate = now;
          }
          state.phi = phiRef.current;
          state.theta = thetaRef.current;
        },
      });
    };

    // Initialize immediately at stored location
    initGlobe(locationRef.current);

    // 1) Try precise browser geolocation first
    const tryBrowserGeo = () => new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject('no-geo');
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => reject('denied'),
        { timeout: 5000, maximumAge: 60000 }
      );
    });

    // 2) Fallback: IP-based geolocation (ip-api is more reliable than ipapi.co)
    const controller = new AbortController();
    const tryIpGeo = () =>
      fetch('https://ip-api.com/json/?fields=lat,lon', { signal: controller.signal })
        .then((r) => r.json())
        .then((d) => {
          if (d?.lat && d?.lon) return { lat: d.lat, lng: d.lon };
          throw new Error('bad response');
        });

    (async () => {
      try {
        const loc = await tryBrowserGeo();
        locationRef.current = loc;
        initGlobe(loc);
      } catch {
        try {
          const loc = await tryIpGeo();
          locationRef.current = loc;
          initGlobe(loc);
        } catch {
          // stay at default
        }
      }
    })();

    // Pointer drag handlers (on canvas only — avoids global listener cost)
    const onPointerDown = (e) => {
      isDraggingRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      phiRef.current += dx * 0.005;
      thetaRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, thetaRef.current + dy * 0.005));
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      canvas.style.cursor = 'grab';
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // Pause rendering when tab is hidden — big CPU win
    const onVisibilityChange = () => {
      if (document.hidden && globeRef.current) {
        globeRef.current.destroy();
        globeRef.current = null;
      } else if (!document.hidden && !globeRef.current) {
        initGlobe(locationRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      controller.abort();
      cancelAnimationFrame(raf);
      if (globeRef.current) globeRef.current.destroy();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || 'Login failed');
      }
      const payload = await response.json();
      localStorage.setItem('meetai_token', payload.token);
      localStorage.setItem('meetai_user', JSON.stringify(payload.user));
      try { connectSocket(payload.token); } catch (e) { console.error('socket connect failed', e); }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err?.message || 'Unable to login');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-bg-glow" />

      <div className="globe-side">
        <canvas
          ref={canvasRef}
          className="globe-canvas"
          style={{ width: 400, height: 400 }}
        />
        <p className="globe-hint">Drag to explore</p>
      </div>

      <div className="form-side">
        <div className="login-glass-card">
          <div className="login-title-wrapper">
            <div className="login-logo">meetAI</div>
            <h1>Welcome back</h1>
            <p>Sign in to access your meetings.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="demo"
                required
              />
            </div>

            <div className="login-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && <div className="login-error-msg">{error}</div>}

            <button className="login-submit" type="submit" disabled={loading}>
              {loading ? 'Authenticating...' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
