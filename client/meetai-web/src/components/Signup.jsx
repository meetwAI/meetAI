import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Container, Row, Col, Form, Button } from 'react-bootstrap';
import './Login.css';
import { connectSocket } from '../api/socketClient';

export default function Signup() {
  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;
  const navigate = useNavigate();

  const [identifier, setIdentifier] = useState(''); // email
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    // Treat identifier as email; derive username from it if username not separately set
    const email = identifier.trim().toLowerCase();
    const resolvedUsername = username.trim().toLowerCase() || email.split('@')[0];

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: resolvedUsername,
          email,
          password,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || 'Signup failed');
      }

      const payload = await response.json();
      localStorage.setItem('meetai_user', JSON.stringify(payload.user));
        try { connectSocket(); } catch (e) { console.error('socket connect failed', e); }
      navigate('/profile-setup', { replace: true });
    } catch (submitError) {
      setError(submitError?.message || 'Unable to create account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-wrapper">
      {/* Wave Background */}
      <div className="wave-container pointer-events-none">
        <svg className="wave-svg animate-wave" preserveAspectRatio="none" viewBox="0 0 1440 320">
          <path d="M0,224L48,213.3C96,203,192,181,288,181.3C384,181,480,203,576,224C672,245,768,267,864,250.7C960,235,1056,181,1152,165.3C1248,149,1344,171,1392,181.3L1440,192L1440,320L0,320Z" fill="#258cf4" fillOpacity="0.2"></path>
          <path d="M1440,224L1488,213.3C1536,203,1632,181,1728,181.3C1824,181,1920,203,2016,224C2112,245,2208,267,2304,250.7C2400,235,2496,181,2592,165.3C2688,149,2784,171,2832,181.3L2880,192L2880,320L1440,320Z" fill="#258cf4" fillOpacity="0.2"></path>
        </svg>
        <svg className="wave-svg animate-wave-slow" preserveAspectRatio="none" viewBox="0 0 1440 320">
          <path d="M0,160L48,176C96,192,192,224,288,213.3C384,203,480,149,576,149.3C672,149,768,203,864,197.3C960,192,1056,128,1152,117.3C1248,107,1344,149,1392,170.7L1440,192L1440,320L0,320Z" fill="#258cf4" fillOpacity="0.4"></path>
          <path d="M1440,160L1488,176C1536,192,1632,224,1728,213.3C1824,203,1920,149,2016,149.3C2112,149,2208,203,2304,197.3C2400,192,2496,128,2592,117.3C2688,107,2784,149,2832,170.7L2880,192L2880,320L1440,320Z" fill="#258cf4" fillOpacity="0.4"></path>
        </svg>
      </div>

      <Container fluid className="content-container p-0">
        {/* Header */}
        <header className="d-flex justify-content-between align-items-center py-4 px-4 px-md-5 w-100 border-bottom border-secondary border-opacity-25">
          <div className="d-flex align-items-center gap-2 text-white">
            <span className="material-symbols-outlined fs-2 text-primary">settings_voice</span>
            <h2 className="mb-0 fw-black text-white tracking-tight">TranscribeAI</h2>
          </div>
          <nav className="d-none d-md-flex align-items-center gap-4">
            <Link to="/login" className="text-white text-decoration-none fw-semibold small opacity-75">
              Already have an account? <span className="text-primary fw-bold">Sign in</span>
            </Link>
          </nav>
        </header>

        <Row className="flex-grow-1 align-items-center justify-content-center w-100 mx-0 py-2 py-lg-4" style={{ maxWidth: '1440px', alignSelf: 'center' }}>
          {/* Left Column */}
          <Col lg={6} className="text-center text-lg-start px-4 px-lg-5 mb-4 mb-lg-0">
            <h1 className="display-4 fw-black text-white mb-3 tracking-tighter lh-sm">
              Your meetings,<br /><span className="text-primary">intelligently captured</span>
            </h1>
            <p className="fs-5 text-secondary mb-4 fw-medium lh-lg w-75 mx-auto mx-lg-0">
              Join thousands of professionals who save hours every week with AI-powered transcription, summaries, and action items.
            </p>

            <div className="d-flex flex-column gap-3 mt-4" style={{ maxWidth: '360px', marginLeft: 0 }}>
              {[
                { icon: 'mic', label: 'Real-time transcription' },
                { icon: 'summarize', label: 'Instant AI summaries' },
                { icon: 'task_alt', label: 'Auto action item detection' },
              ].map(({ icon, label }) => (
                <div key={label} className="d-flex align-items-center gap-3">
                  <div className="rounded-circle d-flex align-items-center justify-content-center"
                    style={{ width: 36, height: 36, background: 'rgba(37,140,244,0.15)', flexShrink: 0 }}>
                    <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>{icon}</span>
                  </div>
                  <span className="text-white fw-medium small">{label}</span>
                </div>
              ))}
            </div>
          </Col>

          {/* Right Column — Form */}
          <Col lg={5} xl={4} className="px-4 ps-lg-5">
            <div className="glass-effect p-4 p-md-5 rounded-4 shadow-lg position-relative">
              <div className="mb-4 pb-2">
                <h3 className="fw-bold text-white mb-2 fs-4">Create account</h3>
                <p className="text-secondary small mb-0">Get started — it only takes a minute</p>
              </div>

              <Form onSubmit={handleSubmit}>
                {/* Email */}
                <Form.Group className="mb-4" controlId="identifier">
                  <Form.Label className="text-secondary small fw-bold mb-2">Email Address</Form.Label>
                  <div className="position-relative">
                    <span className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3"
                      style={{ top: '50%', zIndex: 10 }}>mail</span>
                    <Form.Control
                      type="email"
                      placeholder="name@company.com"
                      className="bg-dark-input border-secondary py-3 ps-5 text-white shadow-none"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      required
                    />
                  </div>
                </Form.Group>

                {/* Username */}
                <Form.Group className="mb-4" controlId="username">
                  <Form.Label className="text-secondary small fw-bold mb-2">Username</Form.Label>
                  <div className="position-relative">
                    <span className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3"
                      style={{ top: '50%', zIndex: 10 }}>person</span>
                    <Form.Control
                      type="text"
                      placeholder="janesmith"
                      className="bg-dark-input border-secondary py-3 ps-5 text-white shadow-none"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      minLength={3}
                    />
                  </div>
                  <Form.Text className="text-secondary opacity-50" style={{ fontSize: '0.75rem' }}>
                    Optional — we'll use your email prefix if left blank
                  </Form.Text>
                </Form.Group>

                {/* Password */}
                <Form.Group className="mb-4" controlId="password">
                  <Form.Label className="text-secondary small fw-bold mb-2">Password</Form.Label>
                  <div className="position-relative">
                    <span className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3"
                      style={{ top: '50%', zIndex: 10 }}>lock</span>
                    <Form.Control
                      type={showPassword ? 'text' : 'password'}
                      placeholder="At least 8 characters"
                      className="bg-dark-input border-secondary py-3 ps-5 pe-5 text-white shadow-none"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                    <button
                      type="button"
                      className="btn position-absolute top-50 end-0 translate-middle-y pe-3 ps-1 border-0 bg-transparent text-secondary focus-ring-none"
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      <span className="material-symbols-outlined opacity-75">
                        {showPassword ? 'visibility_off' : 'visibility'}
                      </span>
                    </button>
                  </div>
                </Form.Group>

                {error && <div className="alert alert-danger py-2 small fw-medium">{error}</div>}

                <Button
                  variant="primary"
                  type="submit"
                  className="w-100 py-3 fw-bold shadow-sm d-flex align-items-center justify-content-center gap-2"
                  disabled={loading}
                >
                  {loading ? 'Creating account...' : (
                    <>
                      <span>Continue</span>
                      <span className="material-symbols-outlined">arrow_forward</span>
                    </>
                  )}
                </Button>
              </Form>

              <div className="mt-4 pt-4 border-top border-secondary border-opacity-50 text-center">
                <p className="text-secondary small mb-0">
                  Already have an account?{' '}
                  <Link to="/login" className="text-primary fw-bold text-decoration-none ms-1">Sign in</Link>
                </p>
              </div>
            </div>
          </Col>
        </Row>

        {/* Footer */}
        <footer className="d-flex flex-column flex-md-row justify-content-between align-items-center px-4 px-md-5 py-3 border-top border-secondary border-opacity-25 mt-auto w-100">
          <p className="text-secondary small mb-2 mb-md-0">© 2024 TranscribeAI. All rights reserved.</p>
          <div className="d-flex align-items-center gap-4">
            <a href="#" className="text-secondary small text-decoration-none">Privacy Policy</a>
            <a href="#" className="text-secondary small text-decoration-none">Terms of Service</a>
          </div>
        </footer>
      </Container>
    </div>
  );
}
