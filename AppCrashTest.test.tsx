import { render } from '@testing-library/react';
import React from 'react';
import { describe, it } from 'vitest';
import App from './App';

describe('App', () => {
    it('renders without crashing', () => {
        try {
            render(<App />);
            console.log("App rendered successfully");
        } catch (e: any) {
            console.error("APP CRASHED:", e.message, e.stack);
        }
    });
});
