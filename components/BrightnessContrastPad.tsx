import { useCallback } from 'react';

export const BRIGHTNESS_MIN = 0.2;
export const BRIGHTNESS_MAX = 3.2;
export const CONTRAST_MIN = 0.2;
export const CONTRAST_MAX = 4.2;

interface Props {
  brightness: number;
  contrast: number;
  onChange: (brightness: number, contrast: number) => void;
}

export default function BrightnessContrastPad({ brightness, contrast, onChange }: Props) {
  const dotX = Math.max(0, Math.min(1, (contrast - CONTRAST_MIN) / (CONTRAST_MAX - CONTRAST_MIN)));
  const dotY = Math.max(0, Math.min(1, 1 - (brightness - BRIGHTNESS_MIN) / (BRIGHTNESS_MAX - BRIGHTNESS_MIN)));

  const updateFromPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const newContrast = Math.round((CONTRAST_MIN + x * (CONTRAST_MAX - CONTRAST_MIN)) * 100) / 100;
    const newBrightness = Math.round((BRIGHTNESS_MAX - y * (BRIGHTNESS_MAX - BRIGHTNESS_MIN)) * 100) / 100;
    onChange(newBrightness, newContrast);
  }, [onChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromPointer(e);
  }, [updateFromPointer]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    updateFromPointer(e);
  }, [updateFromPointer]);

  return (
    <div className="flex items-stretch gap-2">
      {/* Brightness axis label — rotated 90°, reads bottom-to-top */}
      <div className="flex items-center justify-center" style={{ width: 14 }}>
        <span
          className="text-slate-600 text-[8px] font-bold uppercase select-none whitespace-nowrap"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', letterSpacing: '0.18em' }}
        >
          Brightness
        </span>
      </div>

      {/* Pad + contrast label */}
      <div className="flex flex-col gap-1 flex-1">
        <div
          className="relative bg-slate-900 border border-slate-700 rounded cursor-crosshair select-none"
          style={{ aspectRatio: '2 / 1' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
        >
          {/* Crosshair at midpoint of each axis */}
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{ top: '50%', borderTop: '1px solid rgba(255,255,255,0.15)' }}
          />
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: '50%', borderLeft: '1px solid rgba(255,255,255,0.15)' }}
          />

          {/* Dot */}
          <div
            className="absolute rounded-full bg-white pointer-events-none shadow-md"
            style={{
              width: 10,
              height: 10,
              left: `${dotX * 100}%`,
              top: `${dotY * 100}%`,
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>

        {/* Contrast axis label */}
        <div className="flex justify-center">
          <span className="text-slate-600 text-[8px] font-bold uppercase select-none tracking-widest">
            Contrast
          </span>
        </div>
      </div>
    </div>
  );
}
