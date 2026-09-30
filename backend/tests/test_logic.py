from app.main import classify, score, distance
def test_classification(): assert classify('deep pothole is dangerous')[0]=='pothole'
def test_evidence_increases_risk(): assert score(4,3,'reported') > score(4,1,'reported')
def test_distance(): assert distance(12.0,77.0,12.0,77.0)==0
