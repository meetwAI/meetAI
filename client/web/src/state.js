import { signal } from '@preact/signals-react';

export const sidebarState = signal(true);

export const openPreviousMeetingsSidebar = () => {
	sidebarState.value = true;
};

export const closePreviousMeetingsSidebar = () => {
	sidebarState.value = false;
};

export const togglePreviousMeetingsSidebar = () => {
	sidebarState.value = !sidebarState.value;
};

export const activeMeetingIdState = signal(null);

export const liveTranscriptSignal = signal({
  meetingId: null,
  lines: [],
  bufferTranscription: '',
  bufferDiarization: '',
  asrStatus: 'idle',
  updatedAt: null,
});

export const isSummaryLoadingState = signal(false);