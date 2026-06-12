import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Row, Col, Form, Button } from 'react-bootstrap';
import './Login.css';
import { fetchWithAuth } from '../lib/http';

const FIELDS = [
    { id: 'name', label: 'Full Name', type: 'text', placeholder: 'Jane Smith', icon: 'badge' },
    { id: 'age', label: 'Age', type: 'number', placeholder: '28', icon: 'cake' },
    { id: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+1 555 000 0000', icon: 'phone' },
    { id: 'location', label: 'Location', type: 'text', placeholder: 'New York, USA', icon: 'location_on' },
];

export default function ProfileSetup() {
    const navigate = useNavigate();
    const [form, setForm] = useState({ name: '', age: '', phone: '', location: '' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleChange = (id) => (e) => setForm((prev) => ({ ...prev, [id]: e.target.value }));

    const handleSubmit = async (event) => {
        event.preventDefault();
        setError('');
        setLoading(true);

        try {
            const body = {
                name: form.name.trim() || undefined,
                age: form.age ? Number(form.age) : undefined,
                phone: form.phone.trim() || undefined,
                location: form.location.trim() || undefined,
            };

            const res = await fetchWithAuth('/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const payload = await res.json().catch(() => ({}));
                throw new Error(payload?.message || 'Failed to save profile');
            }

            const { user } = await res.json();
            // Update cached user with new profile fields
            localStorage.setItem('meetai_user', JSON.stringify(user));
        } catch (err) {
            // Don't block the user from proceeding — profile save is best-effort
            console.error('[profile-setup] save failed', err);
        } finally {
            setLoading(false);
        }

        // Always proceed to login
        navigate('/login', { replace: true });
    };

    const handleSkip = () => navigate('/login', { replace: true });

    return (
        <div className="login-page-wrapper">
            {/* Wave Background */}
            <div className="wave-container pointer-events-none">
                <svg className="wave-svg animate-wave" preserveAspectRatio="none" viewBox="0 0 1440 320">
                    <path d="M0,224L48,213.3C96,203,192,181,288,181.3C384,181,480,203,576,224C672,245,768,267,864,250.7C960,235,1056,181,1152,165.3C1248,149,1344,171,1392,181.3L1440,192L1440,320L0,320Z" fill="#258cf4" fillOpacity="0.2" />
                    <path d="M1440,224L1488,213.3C1536,203,1632,181,1728,181.3C1824,181,1920,203,2016,224C2112,245,2208,267,2304,250.7C2400,235,2496,181,2592,165.3C2688,149,2784,171,2832,181.3L2880,192L2880,320L1440,320Z" fill="#258cf4" fillOpacity="0.2" />
                </svg>
                <svg className="wave-svg animate-wave-slow" preserveAspectRatio="none" viewBox="0 0 1440 320">
                    <path d="M0,160L48,176C96,192,192,224,288,213.3C384,203,480,149,576,149.3C672,149,768,203,864,197.3C960,192,1056,128,1152,117.3C1248,107,1344,149,1392,170.7L1440,192L1440,320L0,320Z" fill="#258cf4" fillOpacity="0.4" />
                    <path d="M1440,160L1488,176C1536,192,1632,224,1728,213.3C1824,203,1920,149,2016,149.3C2112,149,2208,203,2304,197.3C2400,192,2496,128,2592,117.3C2688,107,2784,149,2832,170.7L2880,192L2880,320L1440,320Z" fill="#258cf4" fillOpacity="0.4" />
                </svg>
            </div>

            <Container fluid className="content-container p-0">
                {/* Header */}
                <header className="d-flex justify-content-between align-items-center py-4 px-4 px-md-5 w-100 border-bottom border-secondary border-opacity-25">
                    <div className="d-flex align-items-center gap-2 text-white">
                        <span className="material-symbols-outlined fs-2 text-primary">settings_voice</span>
                        <h2 className="mb-0 fw-black text-white tracking-tight">MeetAI</h2>
                    </div>
                    <button
                        type="button"
                        className="btn btn-link text-secondary small fw-semibold text-decoration-none p-0"
                        onClick={handleSkip}
                    >
                        Skip for now
                    </button>
                </header>

                <Row className="flex-grow-1 align-items-center justify-content-center w-100 mx-0 py-2 py-lg-4" style={{ maxWidth: '1440px', alignSelf: 'center' }}>
                    {/* Left Column */}
                    <Col lg={6} className="text-center text-lg-start px-4 px-lg-5 mb-4 mb-lg-0">
                        <div className="mb-3">
                            <span className="badge text-bg-primary px-3 py-2 rounded-pill fw-semibold small mb-3 d-inline-block">
                                Step 2 of 2
                            </span>
                        </div>
                        <h1 className="display-4 fw-black text-white mb-3 tracking-tighter lh-sm">
                            Tell us a little<br /><span className="text-primary">about yourself</span>
                        </h1>
                        <p className="fs-5 text-secondary mb-0 fw-medium lh-lg w-75 mx-auto mx-lg-0">
                            This helps us personalise your experience. All fields are optional — you can always update this later from your profile.
                        </p>
                    </Col>

                    {/* Right Column — Form */}
                    <Col lg={5} xl={4} className="px-4 ps-lg-5">
                        <div className="glass-effect p-4 p-md-5 rounded-4 shadow-lg position-relative">
                            <div className="mb-4 pb-2">
                                <h3 className="fw-bold text-white mb-2 fs-4">Your profile</h3>
                                <p className="text-secondary small mb-0">All optional — skip any field you like</p>
                            </div>

                            <Form onSubmit={handleSubmit}>
                                {FIELDS.map(({ id, label, type, placeholder, icon }) => (
                                    <Form.Group className="mb-4" controlId={id} key={id}>
                                        <Form.Label className="text-secondary small fw-bold mb-2">{label}</Form.Label>
                                        <div className="position-relative">
                                            <span
                                                className="material-symbols-outlined position-absolute translate-middle-y text-secondary opacity-75 ms-3"
                                                style={{ top: '50%', zIndex: 10 }}
                                            >
                                                {icon}
                                            </span>
                                            <Form.Control
                                                type={type}
                                                placeholder={placeholder}
                                                className="bg-dark-input border-secondary py-3 ps-5 text-white shadow-none"
                                                value={form[id]}
                                                onChange={handleChange(id)}
                                                min={type === 'number' ? 1 : undefined}
                                                max={type === 'number' ? 150 : undefined}
                                            />
                                        </div>
                                    </Form.Group>
                                ))}

                                {error && <div className="alert alert-danger py-2 small fw-medium">{error}</div>}

                                <Button
                                    variant="primary"
                                    type="submit"
                                    className="w-100 py-3 fw-bold shadow-sm d-flex align-items-center justify-content-center gap-2"
                                    disabled={loading}
                                >
                                    {loading ? 'Saving...' : (
                                        <>
                                            <span>Finish & Sign In</span>
                                            <span className="material-symbols-outlined">arrow_forward</span>
                                        </>
                                    )}
                                </Button>
                            </Form>

                            <div className="mt-3 text-center">
                                <button
                                    type="button"
                                    className="btn btn-link text-secondary small text-decoration-none p-0"
                                    onClick={handleSkip}
                                >
                                    Skip for now
                                </button>
                            </div>
                        </div>
                    </Col>
                </Row>
            </Container>
        </div>
    );
}
