import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import './LandingPage.css';

const LandingPage = () => {
    const [activeTab, setActiveTab] = useState('transcripts');

    return (
        <div className="landing-container">
            <header className="landing-header">
                <div className="logo">
                    <span>meetAI</span>
                </div>
                <nav className="nav-links">
                    <a href="#home">Home</a>
                    <a href="#about">About</a>
                    <a href="#features">Features</a>
                    <a href="#services">Services</a>
                </nav>
                <div className="auth-buttons">
                    <Link to="/login" className="btn-signin">Sign in</Link>
                    <Link to="/signup" className="btn-signup">Sign up</Link>
                </div>
            </header>

            <section id="home" className="hero-section">
                <h1 className="hero-title">MEET AI<br />ASSISTANT</h1>
                <p className="hero-text">
                    The most popular and trusted AI meeting assistant. We capture your conversations so you can focus on the connection.
                </p>
            </section>

            {/* Abstract sleek image representing AI / Meetings */}
            <img src="https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=2069" alt="Modern office meeting" className="hero-image" />

            <section id="about" className="features-section">
                <div className="features-grid">
                    <div className="feature-images">
                        <div className="feature-img-box">
                            <img src="https://images.unsplash.com/photo-1542744173-8e7e53415bb0?auto=format&fit=crop&q=80&w=1000" alt="Team collaborating" />
                        </div>
                        <div className="feature-img-box">
                            <img src="https://images.unsplash.com/photo-1573164713988-8665fc963095?auto=format&fit=crop&q=80&w=1000" alt="Technology abstract" />
                        </div>
                    </div>
                    <div>
                        <p style={{ textTransform: 'uppercase', fontSize: '0.8rem', letterSpacing: '2px', color: '#666', marginBottom: '8px' }}>About Us</p>
                        <h2 style={{ fontSize: '2.5rem', margin: '0 0 24px 0', lineHeight: 1.2 }}>The Highest Level of Focus and Productivity</h2>
                        <p style={{ color: '#666', lineHeight: 1.6, fontSize: '1.1rem', marginBottom: '32px' }}>
                            At meetAI, we combine advanced speech recognition with powerful LLMs. Whether it's a quick 1-on-1 or a large team sync, we take care of the notes so you can engage fully in every moment.
                        </p>

                        <h3 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '24px', marginTop: '48px' }}>Why Choose Us?</h3>
                        <div className="feature-cards">
                            <div className="feature-card">
                                <div className="feature-icon">✨</div>
                                <h4 className="feature-title">Real-time AI</h4>
                                <p className="feature-desc">Transcripts stream live as you speak.</p>
                            </div>
                            <div className="feature-card dark">
                                <div className="feature-icon">🔒</div>
                                <h4 className="feature-title">Secure & Private</h4>
                                <p className="feature-desc">Your meetings remain fully encrypted.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section id="services" className="services-section">
                <div style={{ textAlign: 'center', marginBottom: '40px' }}>
                    <p style={{ textTransform: 'uppercase', fontSize: '0.8rem', letterSpacing: '2px', color: '#666', marginBottom: '8px' }}>Services</p>
                    <h2 className="section-title" style={{ margin: 0 }}>What we offer?</h2>
                </div>

                <div className="services-layout">
                    <div className="service-tabs">
                        <button className={`service-tab ${activeTab === 'transcripts' ? 'active' : ''}`} onClick={() => setActiveTab('transcripts')}>
                            Smart Transcripts
                        </button>
                        <button className={`service-tab ${activeTab === 'summaries' ? 'active' : ''}`} onClick={() => setActiveTab('summaries')}>
                            Executive Summaries
                        </button>
                        <button className={`service-tab ${activeTab === 'actions' ? 'active' : ''}`} onClick={() => setActiveTab('actions')}>
                            Action Items
                        </button>
                        <button className={`service-tab ${activeTab === 'insights' ? 'active' : ''}`} onClick={() => setActiveTab('insights')}>
                            Meeting Insights
                        </button>
                    </div>
                    <div className="service-content">
                        <div className="service-text">
                            <p style={{ textTransform: 'uppercase', fontSize: '0.8rem', letterSpacing: '2px', color: '#666', marginBottom: '8px' }}>AS YOU WISH</p>
                            <h3>
                                {activeTab === 'transcripts' && 'Accurate Transcripts'}
                                {activeTab === 'summaries' && 'Clear Summaries'}
                                {activeTab === 'actions' && 'Instant Action Items'}
                                {activeTab === 'insights' && 'Deep Insights'}
                            </h3>
                            <p>
                                {activeTab === 'transcripts' && 'Enjoy a personalized journey with our advanced speech recognition. Every word is captured with high precision, mapping speakers automatically.'}
                                {activeTab === 'summaries' && 'Save hours of reading. Our AI distills hour-long meetings into brief, highly informative summaries that capture the essence of the discussion.'}
                                {activeTab === 'actions' && 'Never drop the ball again. We automatically detect commitments made during the call and organize them into actionable tasks.'}
                                {activeTab === 'insights' && 'Understand team dynamics, speaking time, and sentiment analysis to improve how your organization connects.'}
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f5f5f5', padding: '12px 16px', borderRadius: '12px', width: 'fit-content' }}>
                                <span>🎯</span>
                                <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>Perfect for teams</span>
                            </div>
                        </div>
                        <div className="service-image">
                            <img src="https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&q=80&w=800" alt="Dashboard preview" />
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default LandingPage;
