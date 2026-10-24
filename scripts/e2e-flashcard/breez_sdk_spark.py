# A stand-in for breez-sdk-spark in the e2e mint's environment (see the header
# of nutshell-constraints.txt). Nutshell 0.20.3 imports every Lightning backend
# when it starts, and its Spark backend (cashu/lightning/sparkl2.py) imports
# breez_sdk_spark and subclasses breez_sdk_spark.EventListener as it loads. The
# FakeWallet mint never calls the Spark backend, so every name the import asks
# for resolves to an empty class, and the mint no longer depends on which
# breez-sdk-spark releases PyPI still carries.


def __getattr__(name):
    return type(name, (), {})
