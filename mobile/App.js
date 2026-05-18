import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import { Button, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || '';

export default function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState('Not tested yet.');

  const loginUrl = useMemo(() => `${API_BASE_URL}/login`, []);

  async function testLogin() {
    if (!API_BASE_URL) {
      setResult('Set EXPO_PUBLIC_API_BASE_URL before testing.');
      return;
    }

    try {
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });

      const text = await response.text();
      setResult(`Status ${response.status}: ${text.slice(0, 200)}`);
    } catch (error) {
      setResult(`Request failed: ${String(error?.message || error)}`);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Stick A Pin Mobile (Expo)</Text>
      <Text style={styles.meta}>API: {API_BASE_URL || 'Not configured'}</Text>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          secureTextEntry
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
        />
        <Button title="Test Login Endpoint" onPress={testLogin} />
      </View>

      <Text style={styles.result}>{result}</Text>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'stretch',
    justifyContent: 'center',
    padding: 20,
    gap: 12
  },
  title: {
    fontSize: 24,
    fontWeight: '700'
  },
  meta: {
    color: '#666'
  },
  form: {
    gap: 10
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  result: {
    marginTop: 8,
    color: '#222'
  }
});
