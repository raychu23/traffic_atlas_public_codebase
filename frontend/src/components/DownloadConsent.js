import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

function DownloadConsent() {
  const navigate = useNavigate();
  const { datasetId } = useParams();

  useEffect(() => {
    navigate(`/download/${datasetId}/metadata`, { replace: true });
  }, [datasetId, navigate]);

  return null;
}

export default DownloadConsent;
