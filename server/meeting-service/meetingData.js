const getDummyMeeting = () => ({
  id: 'meet-001',
  title: 'Weekly Product Sync',
  date: 'Jan 31, 2026',
  durationMinutes: 52,
  participants: ['Ava', 'Nia', 'Zane', 'Ishaan'],
  summary: 'Aligned on onboarding scope and confirmed launch risks.',
  actionItems: [
    'Finalize onboarding checklist',
    'Confirm analytics event list',
    'Review launch risk mitigations',
  ],
});

module.exports = { getDummyMeeting };
