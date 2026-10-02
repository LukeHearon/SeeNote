import React from 'react';
import ConfirmDialog from './ConfirmDialog';

/**
 * A modal with a title, a message, and one dismiss button — for reporting an
 * error the user has to see rather than a line in the debug console.
 */
export default function MessageDialog({ title, message, okLabel, onClose }: {
  title: string;
  message: string;
  okLabel: string;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={title}
      message={message}
      actions={[{ label: okLabel, onClick: onClose }]}
      onDismiss={onClose}
    />
  );
}
