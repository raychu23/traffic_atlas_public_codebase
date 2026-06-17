const storage = require('./storage');

const sampleDatasets = [
  {
    title: 'Downtown Intersection Traffic Flow - Morning Rush Hour',
    description: 'Comprehensive video dataset capturing traffic patterns at a major downtown intersection during morning rush hours (7-9 AM). Includes pedestrian movements, vehicle turning patterns, and signal timing observations. Collected over 3 months.',
    uploadedBy: 'system',
    uploaderName: 'Traffic Research Lab',
    uploaderEmail: 'research@trafficlab.edu',
    uploaderOrganization: 'Traffic Research Lab',
    uploaderRole: 'researcher',
    associatedOrganization: 'Traffic Research Lab',
    project: 'Urban Traffic Pattern Analysis',
    purposeOfCollection: 'Research on traffic flow optimization and signal timing improvements',
    location: 'Downtown Metro Area, Main St & 5th Ave Intersection',
    collectionDate: '2024-01-15',
    captureMethod: 'CCTV',
    keywords: 'intersection, rush hour, morning traffic, pedestrian, signal timing, urban',
    tags: 'urban, intersection, rush-hour, cctv, research',
    source: 'City Traffic Management System',
    citation: 'Traffic Research Lab. Downtown Intersection Traffic Flow Dataset. 2024.',
    privacyDeclaration: 'All personally identifiable information has been anonymized. License plates and faces are blurred.',
    accessPreference: 'open',
    allowedUses: 'research, education, aiTraining, classProject',
    preferredCitation: 'Downtown Intersection Traffic Flow - Morning Rush Hour. Traffic Research Lab, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  },
  {
    title: 'Highway Traffic Monitoring - Multi-Lane Analysis',
    description: 'High-resolution video footage from highway monitoring cameras showing multi-lane traffic patterns, lane changes, merging behavior, and speed variations. Data collected during various times of day including peak and off-peak hours.',
    uploadedBy: 'system',
    uploaderName: 'Department of Transportation',
    uploaderEmail: 'data@dot.gov',
    uploaderOrganization: 'State Department of Transportation',
    uploaderRole: 'DOT',
    associatedOrganization: 'State Department of Transportation',
    project: 'Highway Safety and Efficiency Study',
    purposeOfCollection: 'Analysis of highway traffic patterns for infrastructure planning and safety improvements',
    location: 'Interstate 95, Mile Marker 42-45',
    collectionDate: '2024-02-20',
    captureMethod: 'Traffic Camera',
    keywords: 'highway, multi-lane, lane change, merging, speed analysis, traffic flow',
    tags: 'highway, traffic-camera, multi-lane, safety, infrastructure',
    source: 'DOT Highway Monitoring System',
    citation: 'State Department of Transportation. Highway Traffic Monitoring Dataset. 2024.',
    privacyDeclaration: 'Public highway footage. All data collected in compliance with state privacy regulations.',
    accessPreference: 'open',
    allowedUses: 'research, education, aiTraining, commercial',
    preferredCitation: 'Highway Traffic Monitoring - Multi-Lane Analysis. State Department of Transportation, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  },
  {
    title: 'Drone Footage - Roundabout Traffic Patterns',
    description: 'Aerial video footage captured via drone showing traffic patterns at a busy roundabout. Includes overhead views of vehicle movements, entry/exit patterns, and pedestrian crossings. Unique perspective for traffic flow analysis.',
    uploadedBy: 'system',
    uploaderName: 'Urban Planning Institute',
    uploaderEmail: 'data@urbanplanning.edu',
    uploaderOrganization: 'Urban Planning Institute',
    uploaderRole: 'researcher',
    associatedOrganization: 'Urban Planning Institute',
    project: 'Roundabout Efficiency Study',
    purposeOfCollection: 'Research on roundabout design effectiveness and traffic flow optimization',
    location: 'University District, Campus Roundabout',
    collectionDate: '2024-03-10',
    captureMethod: 'Drone',
    keywords: 'roundabout, aerial view, drone, traffic pattern, overhead, vehicle movement',
    tags: 'drone, roundabout, aerial, traffic-pattern, research',
    source: 'Drone Survey Project',
    citation: 'Urban Planning Institute. Roundabout Traffic Patterns Dataset. 2024.',
    privacyDeclaration: 'Aerial footage with limited personal identification. Collected with proper permits.',
    accessPreference: 'request',
    allowedUses: 'research, education',
    preferredCitation: 'Drone Footage - Roundabout Traffic Patterns. Urban Planning Institute, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  },
  {
    title: 'Dashcam Dataset - City Street Driving',
    description: 'Extensive collection of dashcam footage from city street driving scenarios. Includes various road conditions, weather conditions, and traffic scenarios. Useful for autonomous vehicle training and traffic behavior analysis.',
    uploadedBy: 'system',
    uploaderName: 'Autonomous Vehicle Research Center',
    uploaderEmail: 'datasets@avrc.edu',
    uploaderOrganization: 'Autonomous Vehicle Research Center',
    uploaderRole: 'researcher',
    associatedOrganization: 'Autonomous Vehicle Research Center',
    project: 'Autonomous Vehicle Perception Training',
    purposeOfCollection: 'Training data for autonomous vehicle perception systems and traffic scenario recognition',
    location: 'Various city streets, Metro Area',
    collectionDate: '2024-01-05',
    captureMethod: 'Dashcam',
    keywords: 'dashcam, city driving, autonomous vehicle, perception, traffic scenarios, weather',
    tags: 'dashcam, autonomous-vehicle, city-driving, perception, training-data',
    source: 'AVRC Data Collection Fleet',
    citation: 'Autonomous Vehicle Research Center. City Street Driving Dataset. 2024.',
    privacyDeclaration: 'Dashcam footage collected with participant consent. All personal information anonymized.',
    accessPreference: 'open',
    allowedUses: 'research, education, aiTraining',
    preferredCitation: 'Dashcam Dataset - City Street Driving. Autonomous Vehicle Research Center, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  },
  {
    title: 'School Zone Traffic Monitoring - Pedestrian Safety',
    description: 'Video dataset focusing on school zone traffic patterns, pedestrian crossings, and safety behaviors. Captured during school arrival and dismissal times. Includes analysis of driver compliance with school zone speed limits.',
    uploadedBy: 'system',
    uploaderName: 'Traffic Safety Research Group',
    uploaderEmail: 'safety@trafficresearch.org',
    uploaderOrganization: 'Traffic Safety Research Group',
    uploaderRole: 'researcher',
    associatedOrganization: 'Traffic Safety Research Group',
    project: 'School Zone Safety Initiative',
    purposeOfCollection: 'Research on pedestrian safety in school zones and driver behavior analysis',
    location: 'Lincoln Elementary School Zone, Oak Street',
    collectionDate: '2024-02-28',
    captureMethod: 'CCTV',
    keywords: 'school zone, pedestrian safety, speed limit, children, safety, traffic monitoring',
    tags: 'school-zone, pedestrian-safety, cctv, safety-research, children',
    source: 'School District Traffic Monitoring System',
    citation: 'Traffic Safety Research Group. School Zone Traffic Monitoring Dataset. 2024.',
    privacyDeclaration: 'Footage collected with school district approval. Children\'s faces are blurred for privacy.',
    accessPreference: 'request',
    allowedUses: 'research, education',
    preferredCitation: 'School Zone Traffic Monitoring - Pedestrian Safety. Traffic Safety Research Group, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  },
  {
    title: 'Construction Zone Traffic Management',
    description: 'Video footage documenting traffic patterns and management strategies in active construction zones. Includes lane closures, temporary traffic control, and driver behavior in work zones. Collected over multiple construction projects.',
    uploadedBy: 'system',
    uploaderName: 'Infrastructure Research Division',
    uploaderEmail: 'infrastructure@research.gov',
    uploaderOrganization: 'Federal Highway Administration',
    uploaderRole: 'DOT',
    associatedOrganization: 'Federal Highway Administration',
    project: 'Work Zone Safety and Efficiency',
    purposeOfCollection: 'Analysis of traffic management effectiveness in construction zones and safety improvements',
    location: 'Multiple construction sites, Interstate 80',
    collectionDate: '2024-03-15',
    captureMethod: 'Traffic Camera',
    keywords: 'construction zone, work zone, lane closure, traffic management, safety, infrastructure',
    tags: 'construction, work-zone, traffic-management, safety, infrastructure',
    source: 'FHWA Work Zone Monitoring Program',
    citation: 'Federal Highway Administration. Construction Zone Traffic Management Dataset. 2024.',
    privacyDeclaration: 'Public roadway footage. All data collected in compliance with federal regulations.',
    accessPreference: 'open',
    allowedUses: 'research, education, commercial',
    preferredCitation: 'Construction Zone Traffic Management. Federal Highway Administration, 2024.',
    fileName: null,
    filePath: null,
    fileSize: null
  }
];

const mockUploadRequests = [
  {
    metadata: {
      title: 'I-35 Corridor Sample Clips - Approval Request',
      description: 'Representative subset from corridor cameras covering weekday PM peak. Includes short clips across multiple segments and basic metadata.',
      keywords: 'corridor, camera, peak-hour, sample, freeway',
      tags: 'sample, corridor, freeway',
      associatedOrganization: 'Metro Traffic Analytics Lab',
      uploaderRole: 'Researcher',
      accessPreference: 'request',
      allowedUses: {
        research: true,
        education: true,
        aiTraining: true,
        commercial: false,
        classProject: false
      },
      preferredCitation: 'Metro Traffic Analytics Lab. I-35 Corridor Sample Clips. 2026.'
    }
  }
];

async function createMockAdminRequests() {
  console.log('Seeding mock admin review requests...');

  const submitters = [];
  for (let i = 0; i < 3; i++) {
    const user = await storage.createUser({
      name: `Mock User ${i + 1}`,
      email: `mock.user${i + 1}@example.org`,
      organization: i === 1 ? 'City Mobility Office' : 'Metro Traffic Analytics Lab',
      role: i === 1 ? 'government' : 'researcher'
    });
    submitters.push(user);
  }

  for (let i = 0; i < mockUploadRequests.length; i++) {
    const submitter = submitters[i % submitters.length];
    const metadata = {
      uploadedBy: submitter.userId,
      uploaderName: submitter.name,
      uploaderEmail: submitter.email,
      ...mockUploadRequests[i].metadata
    };

    const request = await storage.createUploadRequest(submitter.userId, {
      metadata,
      sampleFileSize: 128000 + i * 32000,
      sampleFileName: `sample_submission_${i + 1}.zip`
    });

    await storage.saveToStaging(
      request.requestId,
      Buffer.from('PK\x03\x04MOCKZIPDATA'),
      metadata
    );

    console.log(`✓ Created upload request: ${request.requestId}`);
  }

  // Mock download requests are not seeded — they pointed at local-only dataset IDs
  // and showed as "Unknown Dataset" in admin when synced to S3.
}

async function seedDatabase() {
  try {
    console.log('Initializing storage structure...');
    await storage.ensureDir(storage.DATA_ROOT);
    
    console.log('Seeding sample traffic datasets...');
    
    const createdDatasetIds = [];
    for (const dataset of sampleDatasets) {
      // Remove datasetId from datasetData as it will be generated
      const { datasetId, ...datasetData } = dataset;
      const created = await storage.createDataset(datasetData);
      // Handle both camelCase and snake_case formats
      const id = created.datasetId || created.dataset_id;
      createdDatasetIds.push(id);
      console.log(`✓ Created dataset: ${created.title} (ID: ${id})`);
    }

    await createMockAdminRequests();
    
    console.log(`\n✅ Successfully seeded ${sampleDatasets.length} traffic datasets!`);
    process.exit(0);
  } catch (error) {
    console.error('Error seeding storage:', error);
    process.exit(1);
  }
}

seedDatabase();
