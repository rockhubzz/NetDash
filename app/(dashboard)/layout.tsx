import { DeviceProvider } from '@/components/DeviceContext';
import DashboardShell from '@/components/DashboardShell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DeviceProvider>
      <DashboardShell>{children}</DashboardShell>
    </DeviceProvider>
  );
}
