import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Container, Row, Col, Form, Button } from 'react-bootstrap';
import './Login.css';
import { connectSocket } from '../lib/socket';

export default function Login() {

  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get('oauth');
    if (oauthStatus !== 'success') {
      if (oauthStatus === 'error') {
        setError('Google sign-in failed. Please try again.');
      }
      return;
    }

    const finalizeOauth = async () => {
      setOauthLoading(true);
      setError('');
      try {
        const response = await fetch(`${API_URL}/verify`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error('Unable to verify session.');
        }
        const payload = await response.json();
        if (!payload?.user) {
          throw new Error('Missing user profile.');
        }
        localStorage.setItem('meetai_user', JSON.stringify(payload.user));
        try { connectSocket(); } catch (e) { console.error('socket connect failed', e); }
        navigate('/', { replace: true });
      } catch (err) {
        setError(err?.message || 'Unable to complete Google sign-in.');
      } finally {
        setOauthLoading(false);
      }
    };

    finalizeOauth();
  }, [API_URL, navigate]);

  const handleGoogleSignIn = () => {
    setError('');
    window.location.href = `${API_URL}/auth/google`;
  };

  const GoogleIcon = () => (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.74 1.22 9.26 3.62l6.92-6.92C35.98 2.28 30.45 0 24 0 14.64 0 6.55 5.38 2.52 13.22l8.1 6.29C12.84 13.09 17.98 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.55c0-1.64-.15-3.22-.44-4.74H24v9h12.7c-.55 2.97-2.2 5.49-4.7 7.2l7.2 5.58c4.2-3.88 7.3-9.61 7.3-17.04z" />
      <path fill="#FBBC05" d="M10.62 28.51c-.5-1.49-.78-3.08-.78-4.71 0-1.63.28-3.22.78-4.71l-8.1-6.29C.9 15.87 0 19.14 0 23.8c0 4.66.9 7.93 2.52 11l8.1-6.29z" />
      <path fill="#34A853" d="M24 47.6c6.48 0 11.92-2.14 15.89-5.81l-7.2-5.58c-2.01 1.35-4.59 2.14-8.69 2.14-6.02 0-11.16-3.59-13.38-8.71l-8.1 6.29C6.55 42.22 14.64 47.6 24 47.6z" />
    </svg>
  );

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
      localStorage.setItem('meetai_user', JSON.stringify(payload.user));
      try { connectSocket(); } catch (e) { console.error('socket connect failed', e); }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err?.message || 'Unable to login');
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
            <a href="#" className="text-white text-decoration-none fw-semibold small opacity-75 text-hover-primary transition-colors">Product</a>
            <a href="#" className="text-white text-decoration-none fw-semibold small opacity-75 text-hover-primary transition-colors">Features</a>
            <a href="#" className="text-white text-decoration-none fw-semibold small opacity-75 text-hover-primary transition-colors">Pricing</a>
            <a href="#" className="text-white text-decoration-none fw-semibold small opacity-75 text-hover-primary transition-colors">Support</a>
            <Button as={Link} to="/signup" variant="primary" className="fw-bold fs-6 ms-2 px-4 shadow-sm">Sign Up</Button>
          </nav>
        </header>

        <Row className="flex-grow-1 align-items-center justify-content-center w-100 mx-0 py-2 py-lg-4" style={{ maxWidth: '1440px', alignSelf: 'center' }}>
          {/* Left Column - Hero Text */}
          <Col lg={6} className="text-center text-lg-start px-4 px-lg-5 mb-4 mb-lg-0">
            <h1 className="display-4 fw-black text-white mb-3 tracking-tighter lh-sm">
              Transcribe Your World in <span className="text-primary d-inline-block">Real-Time</span>
            </h1>
            <p className="fs-5 text-secondary mb-4 fw-medium lh-lg w-75 mx-auto mx-lg-0">
              Experience the most accurate AI-driven transcription service. Fluid, responsive, and designed for professionals who need precision instantly.
            </p>

            {/*<div className="d-flex flex-column flex-lg-row align-items-center justify-content-center justify-content-lg-start gap-3 mb-4">
              <div className="avatar-group d-flex">
                <img alt="Avatar" className="avatar rounded-circle border border-2 border-dark" src="https://lh3.googleusercontent.com/aida-public/AB6AXuDI9ehNd6qjVryRMrce4R-T7ue45oacPa1zxGVpBoInfCPNjxeQDAySRmuETiNmQy_7LvCep1wu7k9YQ5HIb-FHR9_UodoOGbmvcsGYXrcIsoemZ4dlUtR84VPkfMc-fDDN5eWX5mSSqBubmqEnvBpMd5yriQjR3yu-Doz_eyieDhHC78reet6mnlCbdEs0pA4uhnpt7OaZ7UX8vAUBS6b159e65BUVrvpU0dza17kRe0Oegxo6-bvVolNN2P2NnylhcnRSGeVDQ7N4" />
                <img alt="Avatar" className="avatar rounded-circle border border-2 border-dark" src="https://lh3.googleusercontent.com/aida-public/AB6AXuCG9XbSY5Lcvo13d8TcTRfltayLtDO22mqJYf3h7ekfrgkGsGAfdyXBB4Dfv5XIkm9-W6x6A6eX9lSqHrBkyNddkX6-HwoDbtI1UaW9JYI_OieSiLkZ-Eo0DPmw-KQAZ6-bCkCEOp3v_EH_qHUHAUlkdEjYlzxwmTBfxW3BH22HBkUNvXmdw6wsqRqKoS3j57yVURRHRBiBChulfkkWigLzQOq_4StYHaG3X4Mbb8XS-wCbWPUvnIqmtRT8Hhrg7bKxyrlD3WKqQFyI" />
                <img alt="Avatar" className="avatar rounded-circle border border-2 border-dark" src="https://lh3.googleusercontent.com/aida-public/AB6AXuAcvpRUMhNZJTdIAXgUWkYjcOvx5dCx5Ff9KFPRL9LnJDeVmlpcPSYgfxcB8u0Qx8IX2yJBuYW9BZ5JkJ5JgICvc4LOr40_H8NggMuWTjKF1bbpkKcZ2jxOr4CZEzUvtDQG-Gth8hJELTzYegJ9jWBR8kZbXFotZxkflVO1Q_P16ywSuUiygaUnazLjS4fgWSwKaCgXlzhDylq0tzwmXzHITXeikGsLRx_XBIlGsRvwdba6jITXQtfuTKc9FZkQ7ll8IF-89VU9qCPA" />
              </div>
              <p className="mb-0 text-secondary fw-semibold small">Trusted by 10k+ creators</p>
            </div>*/}

            {/* Carousel moved under Trusted section */}
            <div className="carousel-wrapper position-relative text-center text-lg-start mt-3 pt-2 mx-auto mx-lg-0 w-100" style={{ maxWidth: '400px' }}>
              <div className="carousel-item-custom">
                <span className="text-white opacity-50 fw-bold text-uppercase tracking-wider d-block mb-3 text-sm">Smart Assistant</span>
                <h3 className="fs-3 fw-black text-white text-shadow-sm tracking-tight">"Summarize the last 10 minutes"</h3>
              </div>
              <div className="carousel-item-custom">
                <span className="text-white opacity-50 fw-bold text-uppercase tracking-wider d-block mb-3 text-sm">Voice Intelligence</span>
                <h3 className="fs-3 fw-black text-white text-shadow-sm tracking-tight">"What did Akram say about the budget?"</h3>
              </div>
              <div className="carousel-item-custom">
                <span className="text-white opacity-50 fw-bold text-uppercase tracking-wider d-block mb-3 text-sm">Actionable Insights</span>
                <h3 className="fs-3 fw-black text-white text-shadow-sm tracking-tight">"What tasks were assigned to me?"</h3>
              </div>
            </div>
          </Col>

          {/* Right Column - Form */}
          <Col lg={5} xl={4} className="px-4 ps-lg-5">
            <div className="glass-effect p-4 p-md-5 rounded-4 shadow-lg position-relative">
              <div className="mb-4 pb-2">
                <h3 className="fw-bold text-white mb-2 fs-4">Welcome Back</h3>
                <p className="text-secondary small mb-0">Enter your credentials to access your workspace</p>
              </div>

              <Form onSubmit={handleSubmit}>
                <Form.Group className="mb-4" controlId="username">
                  <Form.Label className="text-secondary small fw-bold mb-2">Email Address</Form.Label>
                  <div className="position-relative">
                    <span className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3" style={{ top: '50%', zIndex: 10 }}>mail</span>
                    <Form.Control
                      type="text"
                      placeholder="name@company.com"
                      className="bg-dark-input border-secondary py-3 ps-5 text-white shadow-none"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                    />
                  </div>
                </Form.Group>

                <Form.Group className="mb-4" controlId="password">
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <Form.Label className="text-secondary small fw-bold mb-0">Password</Form.Label>
                    <a href="#" className="text-primary small fw-semibold text-decoration-none">Forgot Password?</a>
                  </div>
                  <div className="position-relative">
                    <span className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3" style={{ top: '50%', zIndex: 10 }}>lock</span>
                    <Form.Control
                      type="password"
                      placeholder="••••••••"
                      className="bg-dark-input border-secondary py-3 ps-5 pe-5 text-white shadow-none"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button type="button" className="btn position-absolute top-50 end-0 translate-middle-y pe-3 ps-1 border-0 bg-transparent text-secondary text-hover-white focus-ring-none">
                      <span className="material-symbols-outlined opacity-75">visibility</span>
                    </button>
                  </div>
                </Form.Group>

                <Form.Group className="mb-4" controlId="remember">
                  <Form.Check type="checkbox" className="d-flex align-items-center gap-2">
                    <Form.Check.Input type="checkbox" className="bg-dark-input border-secondary shadow-none m-0" />
                    <Form.Check.Label className="text-secondary small pt-1">Keep me logged in</Form.Check.Label>
                  </Form.Check>
                </Form.Group>

                {error && <div className="alert alert-danger py-2 small fw-medium">{error}</div>}

                <Button variant="primary" type="submit" className="w-100 py-3 fw-bold shadow-sm d-flex align-items-center justify-content-center gap-2" disabled={loading || oauthLoading}>
                  {loading ? 'Authenticating...' : (
                    <>
                      <span>Sign In</span>
                      <span className="material-symbols-outlined">arrow_forward</span>
                    </>
                  )}
                </Button>
              </Form>

              <div className="d-flex align-items-center gap-3 my-4">
                <div className="flex-grow-1 border-top border-secondary border-opacity-50" />
                <span className="text-secondary small">or</span>
                <div className="flex-grow-1 border-top border-secondary border-opacity-50" />
              </div>

              <Button
                variant="outline-light"
                type="button"
                className="w-100 py-3 fw-bold d-flex align-items-center justify-content-center gap-2"
                onClick={handleGoogleSignIn}
                disabled={loading || oauthLoading}
              >
                {oauthLoading ? 'Connecting to Google...' : (
                  <>
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </>
                )}
              </Button>

              <div className="mt-4 pt-4 border-top border-secondary border-opacity-50 text-center">
                <p className="text-secondary small mb-0">
                  Don't have an account? <Link to="/signup" className="text-primary fw-bold text-decoration-none ms-1">Create an account</Link>
                </p>
              </div>
            </div>
          </Col>
        </Row>

        {/* Footer */}
        <footer className="d-flex flex-column flex-md-row justify-content-between align-items-center px-4 px-md-5 py-3 border-top border-secondary border-opacity-25 mt-auto w-100">
          <p className="text-secondary small mb-2 mb-md-0">© 2024 TranscribeAI. All rights reserved.</p>
          <div className="d-flex align-items-center gap-4">
            <a href="#" className="text-secondary small text-decoration-none text-hover-primary transition-colors">Privacy Policy</a>
            <a href="#" className="text-secondary small text-decoration-none text-hover-primary transition-colors">Terms of Service</a>
            <div className="d-flex gap-3 ms-2">
              <span className="material-symbols-outlined text-secondary fs-5" role="button">language</span>
              <span className="material-symbols-outlined text-secondary fs-5" role="button">help</span>
            </div>
          </div>
        </footer>
      </Container>
    </div>
  );
}
