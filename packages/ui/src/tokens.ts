export const colors = {
  brand: { navy: '#0A2359', navyDark: '#041D54', red: '#EA0711', cream: '#F6F5F0', white: '#FFFFFF' },
  neutral: { 950: '#111827', 900: '#1F2937', 700: '#374151', 600: '#4B5563', 500: '#6B7280', 400: '#9CA3AF', 300: '#D1D5DB', 200: '#E5E7EB', 100: '#F3F4F6', 50: '#F9FAFB' },
  semantic: { success: '#15803D', warning: '#A16207', danger: '#B91C1C', info: '#1D4ED8' },
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48, '4xl': 64 } as const;
export const radius = { badge: 6, default: 8, panel: 12, mobileCard: 16, pill: 999 } as const;
