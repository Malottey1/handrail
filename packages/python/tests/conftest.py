import pytest

from fake_handrail import AGENT_KEY, FakeHandrail


@pytest.fixture
def handrail():
    fake = FakeHandrail()
    yield fake
    fake.close()


@pytest.fixture
def key():
    return AGENT_KEY
