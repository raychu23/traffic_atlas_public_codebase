import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function UploadConsent() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/upload/metadata', { replace: true });
  }, [navigate]);

  return null;
}

export default UploadConsent;
