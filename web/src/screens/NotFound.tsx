import { ScreenHeader } from '../components/ui.tsx';
import { href, paths } from '../router.ts';

export function NotFound({ path }: { path: string }) {
  return (
    <>
      <ScreenHeader title="Not found" />
      <div className="empty">
        <p>There’s nothing at {path}.</p>
        <p>
          <a href={href(paths.today())}>Go to Today</a>
        </p>
      </div>
    </>
  );
}
