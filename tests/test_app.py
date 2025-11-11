import importlib.util
import pathlib
import json


def load_flask_app():
	app_path = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app.py"
	spec = importlib.util.spec_from_file_location("app", str(app_path))
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)  # type: ignore
	return module.app


def test_app_imports():
	app = load_flask_app()
	assert app is not None


def test_resolve_and_cache_flow(tmp_path, monkeypatch):
	app = load_flask_app()
	client = app.test_client()
	# resolve example.com twice
	r1 = client.post('/api/resolve', data=json.dumps({"domain":"example.com"}), content_type='application/json')
	assert r1.status_code in (200, 504)
	data1 = r1.get_json()
	assert 'steps' in data1
	# second request should be cached if first succeeded
	r2 = client.post('/api/resolve', data=json.dumps({"domain":"example.com"}), content_type='application/json')
	data2 = r2.get_json()
	assert 'steps' in data2
	# cached flag may be true if cache stored successfully
	assert 'cached' in data2


def test_blacklist_blocks(monkeypatch):
	app = load_flask_app()
	client = app.test_client()
	# Add to blacklist
	client.post('/api/blacklist', data=json.dumps({"domain":"blocked.example"}), content_type='application/json')
	r = client.post('/api/resolve', data=json.dumps({"domain":"sub.blocked.example"}), content_type='application/json')
	assert r.status_code == 200
	data = r.get_json()
	assert data.get('blocked') is True


