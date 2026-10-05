import RemoteScreen from '@/components/RemoteScreen';

export default function DevicePage({ params }: { params: { id: string } }) {
  return <RemoteScreen deviceId={params.id} />;
}
