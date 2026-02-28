import React from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import './MainLayout.css';
import { getSocket, connectSocket } from '../api/socketClient';
import { fetchWithAuth } from '../api/fetchWithAuth';
import {Plus} from 'lucide-react'
const MainLayout = ({ username = 'John Doe', userImage = 'https://via.placeholder.com/80' }) => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [captureState, setCaptureState] = React.useState('idle');
    const [captureError, setCaptureError] = React.useState('');
    const [serverMessage, setServerMessage] = React.useState('');
    const displayStreamRef = React.useRef(null);
    const audioStreamRef = React.useRef(null);
    const mediaRecorderRef = React.useRef(null);
    const socketRef = React.useRef(null);
    const chunkIndexRef = React.useRef(0);
    const chunkStartedAtRef = React.useRef(0);
    const activeMeetingIdRef = React.useRef(null);

    const appendMessageToMeetingCache = React.useCallback((meetingId, message) => {
        queryClient.setQueryData(['meeting', String(meetingId)], (current) => {
            if (!current || String(current.id) !== String(meetingId)) {
                return current;
            }
            const messages = Array.isArray(current.messages) ? current.messages : [];
            return { ...current, messages: [...messages, message] };
        });

        queryClient.setQueryData(['meetings', 'dummy'], (current) => {
            const meetings = Array.isArray(current) ? current : [];
            return meetings.map((meeting) => {
                if (String(meeting.id) !== String(meetingId)) {
                    return meeting;
                }
                const messages = Array.isArray(meeting.messages) ? meeting.messages : [];
                return { ...meeting, messages: [...messages, message] };
            });
        });

    }, [queryClient]);

    const stopCapture = React.useCallback(async () => {
        const completedMeetingId = activeMeetingIdRef.current;
        if (mediaRecorderRef.current) {
            if (mediaRecorderRef.current.state !== 'inactive') {
                mediaRecorderRef.current.stop();
            }
            mediaRecorderRef.current = null;
        }
        if (socketRef.current) {
            try {
                socketRef.current.off('connect');
                socketRef.current.off('connect_error');
                socketRef.current.off('meeting-audio-processed');
            } catch (e) {
                // ignore
            }
            socketRef.current = null;
        }
        if (displayStreamRef.current) {
            displayStreamRef.current.getTracks().forEach((track) => track.stop());
            displayStreamRef.current = null;
        }
        if (audioStreamRef.current) {
            audioStreamRef.current.getTracks().forEach((track) => track.stop());
            audioStreamRef.current = null;
        }
        if (completedMeetingId) {
            try {
                await fetchWithAuth(`/meetings/${completedMeetingId}/complete`, { method: 'POST' });
                queryClient.invalidateQueries({ queryKey: ['meetings', 'recent', 3] });
                queryClient.invalidateQueries({ queryKey: ['meetings', 'dummy'] });
                queryClient.invalidateQueries({ queryKey: ['meeting', String(completedMeetingId)] });
            } catch (error) {
                setCaptureError(error?.message || 'Failed to finalize meeting.');
            }
        }
        activeMeetingIdRef.current = null;
        setCaptureState('idle');
    }, [queryClient]);

    const startCapture = React.useCallback(async () => {
        setCaptureError('');
        setServerMessage('');
        setCaptureState('requesting');

        const token = localStorage.getItem('meetai_token');
        if (!token) {
            setCaptureState('idle');
            setCaptureError('Please sign in before recording.');
            return;
        }

        if (!window.isSecureContext) {
            setCaptureState('idle');
            setCaptureError('Screen capture requires HTTPS or localhost.');
            return;
        }

        if (!navigator?.mediaDevices?.getDisplayMedia) {
            setCaptureState('idle');
            setCaptureError('Screen capture is not supported in this browser.');
            return;
        }

        try {
            const createResponse = await fetchWithAuth('/meetings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const createdMeeting = await createResponse.json();
            const meetingId = createdMeeting?.id;
            if (!meetingId) {
                throw new Error('Failed to create meeting.');
            }
            activeMeetingIdRef.current = meetingId;
            queryClient.setQueryData(['meeting', String(meetingId)], {
                id: meetingId,
                title: `Meeting ${meetingId}`,
                date: new Date().toISOString(),
                summary: '',
                participants: [],
                messages: [],
                actionItems: [],
            });
            navigate(`/meetings/${meetingId}`);

            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            });

            const [audioTrack] = displayStream.getAudioTracks();
            if (!audioTrack) {
                displayStream.getTracks().forEach((track) => track.stop());
                throw new Error('No audio track detected. Select a tab with audio sharing enabled.');
            }

            const audioStream = new MediaStream([audioTrack]);
            displayStreamRef.current = displayStream;
            audioStreamRef.current = audioStream;

            let socket = getSocket();
            if (!socket && token) {
                socket = connectSocket(token);
            }
            if (!socket) {
                setCaptureState('idle');
                setCaptureError('Unable to connect to meeting service.');
                return;
            }
            socketRef.current = socket;

            socket.on('connect', () => {
                console.log('[meeting-client] connected to gateway');
                setServerMessage('Connected to meeting service.');
            });
            socket.on('connect_error', (error) => {
                console.error('[meeting-client] gateway connection error', error);
                setCaptureError(error?.message || 'Unable to connect to meeting service.');
            });
            socket.on('meeting-audio-processed', (payload) => {
                console.log('[meeting-client] server response', payload);
                if (payload) {
                    const meetingMessage = typeof payload === 'string' ? payload : payload?.message || '';
                    setServerMessage(meetingMessage);
                    const targetMeetingId = activeMeetingIdRef.current;
                    if (meetingMessage && targetMeetingId) {
                        fetchWithAuth(`/meetings/${targetMeetingId}/messages`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: meetingMessage, role: 'assistant' }),
                        })
                            .then((response) => response.json())
                            .then((messagePayload) => {
                                if (messagePayload?.message) {
                                    appendMessageToMeetingCache(targetMeetingId, messagePayload.message);
                                }
                            })
                            .catch((error) => {
                                console.error('[meeting-client] failed to append stream message', error);
                            });
                    }
                }
            });

            chunkIndexRef.current = 0;
            chunkStartedAtRef.current = Date.now();

            const preferredMimeType = 'audio/webm;codecs=opus';
            const recorderOptions = MediaRecorder.isTypeSupported(preferredMimeType)
                ? { mimeType: preferredMimeType }
                : undefined;

            const mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = async (event) => {
                if (!event.data || event.data.size === 0) {
                    return;
                }

                const durationMs = Date.now() - chunkStartedAtRef.current;
                chunkStartedAtRef.current = Date.now();

                const arrayBuffer = await event.data.arrayBuffer();
                const binaryPayload = new Uint8Array(arrayBuffer);
                const meta = {
                    meetingId: Number(activeMeetingIdRef.current),
                    chunkIndex: Number(chunkIndexRef.current),
                    durationMs: Number(durationMs),
                    mimeType: String(event.data.type || preferredMimeType),
                };
                console.log('[meeting-client] sending chunk', meta);
                socket.emit(
                    'meeting-audio-chunk',
                    meta,
                    binaryPayload,
                );

                chunkIndexRef.current += 1;
            };

            mediaRecorder.start(10_000);

            const [videoTrack] = displayStream.getVideoTracks();
            if (videoTrack) {
                videoTrack.addEventListener('ended', () => {
                    stopCapture();
                });
            }

            setCaptureState('capturing');
        } catch (error) {
            await stopCapture();
            setCaptureError(error?.message || 'Unable to capture tab audio.');
        }
    }, [appendMessageToMeetingCache, navigate, queryClient, stopCapture]);

    return (
        <div className="main-layout">
            <div className="topbar" role="banner">
                <div className="topbar-left">
                    <div className="project-name">meetAI</div>
                </div>
                <nav className="topbar-center topbar-nav" aria-label="Primary">
                    <Link to="/" className="nav-link" aria-label="Home">
                        Home
                    </Link>
                    <Link to="/meetings" className="nav-link" aria-label="Meetings">
                        Meetings
                    </Link>
                    <Link to="/profile" className="nav-link" aria-label="Profile">
                        Profile
                    </Link>
                </nav>
                <div className="topbar-right">
                    {captureState === 'capturing' ? (
                        <button type="button" className="primary-button" onClick={stopCapture}>
                            Stop recording
                        </button>
                    ) : (
                        <button type="button" className="record-pill" onClick={startCapture} aria-label="Meet With AI">
                            <span className="record-pill__icon" aria-hidden="true"><Plus /></span>
                            <span className="record-pill__text">Meet With AI</span>
                        </button>
                    )}
                </div>
            </div>
            {(captureState === 'requesting' || captureState === 'capturing' || serverMessage || captureError) && (
                <div className="px-3" style={{ paddingTop: '8px' }}>
                    {captureState === 'requesting' && (
                        <p className="recap-summary">Waiting for permission to capture a tab…</p>
                    )}
                    {captureState === 'capturing' && (
                        <p className="recap-summary">Capturing tab audio and streaming 60s chunks…</p>
                    )}
                    {serverMessage && <p className="recap-summary">{serverMessage}</p>}
                    {captureError && <p className="recap-summary">{captureError}</p>}
                </div>
            )}

            <main className="main-content">
                <Outlet />
            </main>
        </div>
    );
};

export default MainLayout;
